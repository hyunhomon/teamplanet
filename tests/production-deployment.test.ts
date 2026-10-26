import { expect, test } from "bun:test";
import { createProductionDeployment, deploymentCandidate, recordDeploymentStatus, verifiedRun } from "../.github/scripts/production-deployment";

const repository = "hyunhomon/teamplanet";
const sha = "a".repeat(40);
const event = {
  action: "completed", repository: { full_name: repository },
  workflow_run: {
    id: 123, name: "CI", path: ".github/workflows/ci.yml", status: "completed",
    conclusion: "success", event: "push", head_branch: "main", head_sha: sha,
    head_repository: { full_name: repository },
  },
};
const context = { repository, token: "test-token", apiUrl: "https://api.github.test", serverUrl: "https://github.test", cdRunId: "456", cdRunAttempt: "1" };

test("selects the exact SHA tested by a successful main push CI", () => {
  expect(deploymentCandidate(event, repository, sha)).toEqual({ sha, id: 123 });
});

test.each([
  { conclusion: "failure" }, { conclusion: "cancelled" }, { status: "in_progress" },
  { event: "pull_request" }, { head_branch: "feature" },
  { head_repository: { full_name: "someone/fork" } },
  { head_sha: "main; echo unsafe" }, { name: "Other workflow" },
  { path: ".github/workflows/other.yml" }, { id: -1 },
])("rejects an unsafe or unsuccessful triggering run: %j", change => {
  expect(verifiedRun({ ...event, workflow_run: { ...event.workflow_run, ...change } }, repository)).toBeNull();
});

test("rejects repository mismatch and missing workflow data", () => {
  expect(verifiedRun(event, "other/repository")).toBeNull();
  expect(verifiedRun({}, repository)).toBeNull();
});

test("does not roll production back when an old successful CI is rerun", () => {
  expect(deploymentCandidate(event, repository, "b".repeat(40))).toBeNull();
});

test("logs the verified SHA as a production deployment without creating a release or tag", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const id = await createProductionDeployment({ sha, id: 123 }, context, async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ id: 99 }, { status: 201 });
  });
  expect(id).toBe(99);
  expect(calls).toEqual([{
    url: "https://api.github.test/repos/hyunhomon/teamplanet/deployments",
    body: {
      ref: sha, auto_merge: false, required_contexts: [], environment: "production",
      production_environment: true, transient_environment: false,
      description: "Production via CD #456", payload: { ci_run_id: 123, cd_run_id: "456", cd_run_attempt: "1" },
    },
  }]);
});

test.each([
  ["in_progress", "in_progress"], ["success", "success"],
  ["failure", "failure"], ["cancelled", "error"],
])("records %s with the service URL and CD logs", async (status, expected) => {
  let recorded: unknown;
  await recordDeploymentStatus(99, status!, context, async (url, init) => {
    expect(url).toBe("https://api.github.test/repos/hyunhomon/teamplanet/deployments/99/statuses");
    recorded = JSON.parse(String(init.body));
    return Response.json({ id: 100 }, { status: 201 });
  });
  expect(recorded).toMatchObject({
    state: expected, environment: "production", environment_url: "https://teamplanet.cloby.co",
    log_url: "https://github.test/hyunhomon/teamplanet/actions/runs/456/attempts/1", auto_inactive: false,
  });
});

test("does not convert unknown results or invalid IDs into success", async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return Response.json({}); };
  await expect(recordDeploymentStatus(99, "unknown", context, fetcher)).rejects.toThrow("Unsupported");
  await expect(recordDeploymentStatus(0, "success", context, fetcher)).rejects.toThrow("valid deployment ID");
  expect(requests).toBe(0);
});

test("surfaces GitHub logging failures", async () => {
  await expect(createProductionDeployment({ sha, id: 123 }, context, async () => (
    Response.json({ message: "Forbidden" }, { status: 403 })
  ))).rejects.toThrow("HTTP 403");
  await expect(recordDeploymentStatus(99, "failure", context, async () => (
    Response.json({ message: "Unavailable" }, { status: 503 })
  ))).rejects.toThrow("HTTP 503");
});
