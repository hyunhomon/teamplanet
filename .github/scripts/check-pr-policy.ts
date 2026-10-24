type Milestone = { number: number; state: string };
type PullRequest = { body: string | null; base: { ref: string }; milestone: Milestone | null };
type Issue = { state: string; milestone: Milestone | null; pull_request?: unknown };

/** Validate actual GitHub metadata, rather than trusting checklist assertions. */
export async function checkPrPolicy(pr: PullRequest, getIssue: (number: number) => Promise<Issue>) {
  if (pr.base.ref !== "main") throw new Error("PR base must be main.");
  if (!pr.milestone || pr.milestone.state !== "open") {
    throw new Error("Assign an open milestone to the PR.");
  }
  // Ignore template comments and code examples; each closing reference is a standalone line.
  const body = (pr.body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
  const numbers = [...new Set([...body.matchAll(/^(?:Closes|Fixes|Resolves)[ \t]+#([1-9]\d*)[ \t]*\r?$/gim)]
    .map(match => Number(match[1])))];
  if (!numbers.length) throw new Error("Add a standalone Closes #123 line for an issue in this repository.");

  for (const number of numbers) {
    const issue = await getIssue(number);
    if (issue.pull_request) throw new Error(`#${number} is a PR, not an issue.`);
    if (issue.state !== "open") throw new Error(`Issue #${number} must be open.`);
    if (!issue.milestone || issue.milestone.state !== "open") {
      throw new Error(`Assign an open milestone to issue #${number}.`);
    }
    if (issue.milestone.number !== pr.milestone.number) {
      throw new Error(`PR and issue #${number} must have the same milestone.`);
    }
  }
  return numbers;
}

async function main() {
  const { GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL = "https://api.github.com" } = process.env;
  if (!GITHUB_EVENT_PATH || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
    throw new Error("GitHub event path, repository, and token are required.");
  }
  const event = await Bun.file(GITHUB_EVENT_PATH).json();
  if (!event.pull_request?.number) throw new Error("A pull_request event is required.");
  async function get(path: string) {
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${path}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}. Check repository read permissions and issue number.`);
    return response.json();
  }
  // Re-read the PR so reruns use current body/milestone metadata rather than an old event payload.
  const pr = await get(`pulls/${event.pull_request.number}`) as PullRequest;
  const numbers = await checkPrPolicy(pr, number => get(`issues/${number}`) as Promise<Issue>);
  console.log(`PR policy passed: ${numbers.map(number => `#${number}`).join(", ")}; milestone #${pr.milestone!.number}.`);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
