type WorkflowEvent = {
  action?: string;
  repository?: { full_name?: string };
  workflow_run?: {
    id?: number;
    name?: string;
    path?: string;
    status?: string;
    conclusion?: string;
    event?: string;
    head_branch?: string;
    head_sha?: string;
    head_repository?: { full_name?: string };
  };
};

export type VerifiedRun = { sha: string; id: number };

export function verifiedRun(event: WorkflowEvent, repository: string): VerifiedRun | null {
  const run = event.workflow_run;
  if (event.action !== "completed" || event.repository?.full_name !== repository
    || run?.name !== "CI" || run.path !== ".github/workflows/ci.yml"
    || run.status !== "completed" || run.conclusion !== "success"
    || run.event !== "push" || run.head_branch !== "main"
    || run.head_repository?.full_name !== repository
    || !run.head_sha || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || !Number.isSafeInteger(run.id) || run.id! <= 0) return null;
  return { sha: run.head_sha, id: run.id! };
}

export function deploymentCandidate(event: WorkflowEvent, repository: string, currentMainSha: string) {
  const run = verifiedRun(event, repository);
  return run?.sha === currentMainSha ? run : null;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Context = { repository: string; token: string; apiUrl: string; serverUrl: string; cdRunId: string };

function githubClient(context: Context, fetcher: Fetcher) {
  return async function request<T>(path: string, method = "GET", body?: unknown): Promise<T | null> {
    const response = await fetcher(`${context.apiUrl}/repos/${context.repository}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${context.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return await response.json() as T;
  };
}

export async function publishProductionRelease(run: VerifiedRun, context: Context, fetcher: Fetcher = fetch) {
  const request = githubClient(context, fetcher);
  const tag = `production-${run.sha.slice(0, 12)}`;
  const ref = await request<{ object: { type: string; sha: string } }>(`git/ref/tags/${tag}`);
  if (ref && (ref.object.type !== "commit" || ref.object.sha !== run.sha)) {
    throw new Error(`Release tag ${tag} does not point to the verified commit.`);
  }
  const existing = await request<{ id: number }>(`releases/tags/${tag}`);
  if (existing && !ref) throw new Error(`Release ${tag} has no matching tag.`);
  const repositoryUrl = `${context.serverUrl}/${context.repository}`;
  const body = [
    "## Production 배포", "",
    "- 서비스: https://teamplanet.cloby.co",
    `- 커밋: [${run.sha}](${repositoryUrl}/commit/${run.sha})`,
    `- CI: ${repositoryUrl}/actions/runs/${run.id}`,
    `- CD: ${repositoryUrl}/actions/runs/${context.cdRunId}`,
    `- 배포 확인 시각 (UTC): ${new Date().toISOString()}`,
    "- D1 마이그레이션 → API Worker → 웹 Worker 배포 완료",
    "- `/v1/health`: API·DB 연결 정상 확인", "",
    "구성: `teamplanet-web` → `/v1/*` service binding → `teamplanet-api` → `teamplanet-production` D1.",
    "운영 환경은 production 하나이며 이 릴리즈는 CI가 검증한 커밋의 성공한 배포 기록입니다.",
  ].join("\n");
  const metadata = { name: `Production · ${run.sha.slice(0, 7)}`, body, make_latest: "true" };
  const release = existing
    ? await request<{ html_url: string }>(`releases/${existing.id}`, "PATCH", metadata)
    : await request<{ html_url: string }>("releases", "POST", {
      ...metadata, tag_name: tag, target_commitish: run.sha, draft: false, prerelease: false,
      generate_release_notes: true,
    });
  if (!release?.html_url) throw new Error("GitHub did not return a release URL.");
  return release.html_url;
}

async function main() {
  const { GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GH_TOKEN, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  if (!GITHUB_EVENT_PATH || !GITHUB_REPOSITORY || !GH_TOKEN) throw new Error("GitHub event, repository, and token are required.");
  const event: WorkflowEvent = await Bun.file(GITHUB_EVENT_PATH).json();
  const context: Context = {
    repository: GITHUB_REPOSITORY, token: GH_TOKEN,
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
    cdRunId: process.env.GITHUB_RUN_ID ?? "",
  };
  const mode = process.argv[2];
  if (mode === "check") {
    const request = githubClient(context, fetch);
    const head = verifiedRun(event, GITHUB_REPOSITORY)
      ? await request<{ sha: string }>("commits/main") : null;
    const candidate = deploymentCandidate(event, GITHUB_REPOSITORY, head?.sha ?? "");
    if (!GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(GITHUB_OUTPUT, `deploy=${candidate !== null}\n`);
    console.log(candidate ? `Deploy verified commit ${candidate.sha}` : "Skip: this is not a successful CI of the current main commit.");
  } else if (mode === "publish") {
    const run = verifiedRun(event, GITHUB_REPOSITORY);
    if (!run || !/^\d+$/.test(context.cdRunId)) throw new Error("A trusted CI run and CD run ID are required.");
    const url = await publishProductionRelease(run, context);
    console.log(url);
    if (GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(GITHUB_STEP_SUMMARY, `### Production 배포 완료\n\n[서비스](https://teamplanet.cloby.co/) · [Release](${url})\n`);
    }
  } else throw new Error("Expected check or publish mode.");
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
