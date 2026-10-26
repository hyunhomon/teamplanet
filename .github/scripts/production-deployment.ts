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
type Context = { repository: string; token: string; apiUrl: string; serverUrl: string; cdRunId: string; cdRunAttempt: string };

function runLogUrl(context: Context) {
  return `${context.serverUrl}/${context.repository}/actions/runs/${context.cdRunId}/attempts/${context.cdRunAttempt}`;
}

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

export async function createProductionDeployment(run: VerifiedRun, context: Context, fetcher: Fetcher = fetch) {
  const request = githubClient(context, fetcher);
  const deployment = await request<{ id: number }>("deployments", "POST", {
    ref: run.sha,
    auto_merge: false,
    // The triggering CI has already validated this exact SHA.
    required_contexts: [],
    environment: "production",
    production_environment: true,
    transient_environment: false,
    description: `Production via CD #${context.cdRunId}`,
    payload: { ci_run_id: run.id, cd_run_id: context.cdRunId, cd_run_attempt: context.cdRunAttempt },
  });
  if (!Number.isSafeInteger(deployment?.id) || deployment!.id <= 0) throw new Error("GitHub did not return a deployment ID.");
  return deployment!.id;
}

export async function recordDeploymentStatus(id: number, status: string, context: Context, fetcher: Fetcher = fetch) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("A valid deployment ID is required.");
  const states: Record<string, { state: string; description: string }> = {
    in_progress: { state: "in_progress", description: "Production build and deployment started." },
    success: { state: "success", description: "Production deployment and API/database health check succeeded." },
    failure: { state: "failure", description: "Production build, deployment, or health check failed. See CD logs." },
    cancelled: { state: "error", description: "CD was cancelled. See CD logs for the last completed step." },
  };
  if (!Object.hasOwn(states, status)) throw new Error(`Unsupported deployment status: ${status}`);
  const request = githubClient(context, fetcher);
  await request(`deployments/${id}/statuses`, "POST", {
    ...states[status],
    environment: "production",
    environment_url: "https://teamplanet.cloby.co",
    log_url: runLogUrl(context),
    auto_inactive: false,
  });
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
    cdRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
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
  } else if (mode === "start" || mode === "finish") {
    const run = verifiedRun(event, GITHUB_REPOSITORY);
    if (!run || !/^\d+$/.test(context.cdRunId) || !/^[1-9]\d*$/.test(context.cdRunAttempt)) {
      throw new Error("A trusted CI run and CD run ID/attempt are required.");
    }
    if (mode === "start") {
      if (!GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
      const id = await createProductionDeployment(run, context);
      const { appendFile } = await import("node:fs/promises");
      // Save the ID first, so the final step can report a failed start-status request too.
      await appendFile(GITHUB_OUTPUT, `deployment_id=${id}\n`);
      await recordDeploymentStatus(id, "in_progress", context);
      console.log(`Production deployment #${id} started for ${run.sha}`);
    } else {
      const id = Number(process.env.DEPLOYMENT_ID);
      const status = process.env.DEPLOYMENT_STATUS ?? "";
      await recordDeploymentStatus(id, status, context);
      console.log(`Production deployment #${id}: ${status}`);
      if (GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(GITHUB_STEP_SUMMARY, `### Production 배포: ${status}\n\n커밋: ${run.sha}\n\n[배포 이력](${context.serverUrl}/${context.repository}/deployments) · [실행 로그](${runLogUrl(context)}) · [서비스](https://teamplanet.cloby.co/)\n`);
      }
    }
  } else throw new Error("Expected check, start, or finish mode.");
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
