import { afterEach, beforeEach, expect, test } from "bun:test";
import { resultResponseSchema, evidenceResponseSchema, messageContextSchema } from "@teamplanet/contracts";
import { professors } from "@teamplanet/contracts/fixtures";
import { resultFixture } from "./helpers/result";
import { retentionDeadline } from "@teamplanet/collection";
let f: Awaited<ReturnType<typeof resultFixture>>;
beforeEach(async () => { f = await resultFixture(); }); afterEach(() => f.sqlite.close());
test("result, evidence and transient source context trace only selected student/dimension; no source copied to DB", async () => {
  const result = resultResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/assessments`)).json());
  expect(result.artifacts.candidate.assessments).toHaveLength(1); expect(result.artifacts.snapshot.rubric.selectedCompetencies).toEqual(["clarity"]);
  const e = evidenceResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/evidence/${result.artifacts.evidence[0]!.id}`)).json());
  const context = messageContextSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/messages/${e.evidence.messageIds[0]}`)).json());
  expect(context.messages[0]!.text).toBe(f.text); expect(context.nextAfter).toBeNull();
  expect(JSON.stringify(f.sqlite.query("SELECT * FROM analysis_outputs").all())).not.toContain(f.text);
  expect((await f.call(`analysis-runs/${f.run.id}/messages/message_00000000-0000-4000-8000-000000009999`)).status).toBe(404);
  expect((await f.call(`analysis-runs/${f.run.id}/evidence/evidence_00000000-0000-4000-8000-000000009999`)).status).toBe(404);
});
test("another professor and withdrawal cannot read any result or source", async () => {
  f.setProfessor(professors[1]!); expect((await f.call(`analysis-runs/${f.run.id}/assessments`)).status).toBe(404); f.setProfessor(f.professor);
  f.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = ?", [f.now()]);
  expect((await f.call(`analysis-runs/${f.run.id}/assessments`)).status).toBe(409);
  expect((await f.call(`analysis-runs/${f.run.id}/messages/${f.artifacts.evidence[0]!.messageIds[0]}`)).status).toBe(409);
});
for (const action of ["edit", "deleteSource"] as const) test(`source ${action} invalidates summaries and even a finalized run`, async () => {
  f.sqlite.run("UPDATE analysis_runs SET status = 'finalized' WHERE id = ?", [f.run.id]); f[action]();
  expect((await f.call(`analysis-runs/${f.run.id}/assessments`)).status).toBe(409);
  expect((await (await f.call(`analysis-runs/${f.run.id}`)).json() as any).status).toBe("failed_data");
});
test("Slack outage is 503 with no deletion or epoch invalidation", async () => {
  f.outage(); expect((await f.call(`analysis-runs/${f.run.id}/assessments`)).status).toBe(503);
  expect((f.sqlite.query("SELECT deleted_at FROM message_refs").get() as any).deleted_at).toBeNull();
  expect((f.sqlite.query("SELECT status FROM analysis_runs WHERE id = ?").get(f.run.id) as any).status).toBe("awaiting_professor");
});
test("a substituted summary is rejected and invalidates the entire candidate", async () => {
  const changed = structuredClone(f.artifacts); changed.candidate.assessments[0]!.narrative = "근거 없이 바꾼 주장";
  f.sqlite.run("UPDATE analysis_outputs SET output_json = ? WHERE run_id = ?", [JSON.stringify(changed), f.run.id]);
  expect((await f.call(`analysis-runs/${f.run.id}/assessments`)).status).toBe(409);
  expect((await (await f.call(`analysis-runs/${f.run.id}`)).json() as any).status).toBe("failed_data");
});
test("calendar retention boundary blocks access before cleanup", async () => {
  const end = (f.sqlite.query("SELECT ends_at FROM courses WHERE id = ?").get(f.course.id) as any).ends_at;
  f.setClock(retentionDeadline(end)); expect((await f.call(`analysis-runs/${f.run.id}/assessments`)).status).toBe(409);
});
test("long authorized threads paginate without fetching context outside the run", async () => {
  const long = await resultFixture(25);
  try {
    const id = long.artifacts.evidence[0]!.messageIds[0]!, first = messageContextSchema.parse(await (await long.call(`analysis-runs/${long.run.id}/messages/${id}`)).json());
    expect(first.messages).toHaveLength(20); expect(first.nextAfter).not.toBeNull();
    const second = messageContextSchema.parse(await (await long.call(`analysis-runs/${long.run.id}/messages/${id}?after=${first.nextAfter}`)).json());
    expect(second.messages).toHaveLength(5); expect(second.nextAfter).toBeNull();
    expect(new Set([...first.messages, ...second.messages].map(m => m.id)).size).toBe(25);
  } finally { long.sqlite.close(); }
});
