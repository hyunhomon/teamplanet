import { expect, test } from "bun:test";
import { deploymentCandidate, publishProductionRelease, verifiedRun } from "../.github/scripts/production-release";

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
const context = { repository, token: "test-token", apiUrl: "https://api.github.test", serverUrl: "https://github.test", cdRunId: "456" };

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

test("creates a release targeting the verified SHA after deployment", async () => {
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  const url = await publishProductionRelease({ sha, id: 123 }, context, async (_url, init) => {
    if (init.method === "GET") return new Response(null, { status: 404 });
    writes.push({ method: init.method!, body: JSON.parse(String(init.body)) });
    return Response.json({ html_url: "https://github.test/release" }, { status: 201 });
  });
  expect(url).toBe("https://github.test/release");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ method: "POST", body: { target_commitish: sha, tag_name: `production-${sha.slice(0, 12)}`, draft: false, prerelease: false } });
});

test("rerunning the same deployment updates its release instead of duplicating it", async () => {
  const writes: string[] = [];
  await publishProductionRelease({ sha, id: 123 }, context, async (url, init) => {
    if (url.includes("/git/ref/")) return Response.json({ object: { type: "commit", sha } });
    if (url.includes("/releases/tags/")) return Response.json({ id: 99 });
    writes.push(`${init.method} ${url}`);
    return Response.json({ html_url: "https://github.test/release" });
  });
  expect(writes).toEqual(["PATCH https://api.github.test/repos/hyunhomon/teamplanet/releases/99"]);
});

test("refuses a tag pointing to a different commit without writing", async () => {
  let writes = 0;
  await expect(publishProductionRelease({ sha, id: 123 }, context, async (_url, init) => {
    if (init.method !== "GET") writes++;
    return Response.json({ object: { type: "commit", sha: "b".repeat(40) } });
  })).rejects.toThrow("verified commit");
  expect(writes).toBe(0);
});

test("does not treat GitHub permission errors as a missing release", async () => {
  let requests = 0;
  await expect(publishProductionRelease({ sha, id: 123 }, context, async () => {
    requests++;
    return Response.json({ message: "Forbidden" }, { status: 403 });
  })).rejects.toThrow("HTTP 403");
  expect(requests).toBe(1);
});
