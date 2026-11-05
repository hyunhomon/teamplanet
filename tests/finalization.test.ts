import { afterEach, beforeEach, expect, test } from "bun:test";
import { resultFixture } from "./helpers/result";
import { resultResponseSchema, finalizationResponseSchema } from "@teamplanet/contracts";
import { professors } from "@teamplanet/contracts/fixtures";
import { requestErasure, purgeTeam } from "@teamplanet/collection";
let f: Awaited<ReturnType<typeof resultFixture>>;
beforeEach(async () => { f = await resultFixture(); }); afterEach(() => f.sqlite.close());
export async function finalRequest(f: Awaited<ReturnType<typeof resultFixture>>) {
  const result = resultResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/assessments`)).json());
  return { requestId: crypto.randomUUID(), expectedRunVersion: result.version, artifactHash: result.artifactHash,
    decisions: result.artifacts.candidate.assessments.map(r => ({ studentId: r.studentId, key: r.key, judgement: r.judgement, narrative: "교수가 확인한 설명 사례이다.", reason: "원문과 반례·관찰 한계를 확인했다." })),
    reviewedStudentIds: result.students.map(s => s.id), reviewedEvidenceIds: result.artifacts.evidence.map(e => e.id),
    reviewedIssueIds: [...new Set([...result.artifacts.firstReview.issues, ...result.artifacts.finalReview.issues].map(i => i.id))], limitationsReviewed: true, finalDecisionConfirmed: true };
}
test("professor decisions, reason/actor/time and AI original survive independently; identical request is idempotent", async () => {
  const body = await finalRequest(f), path = `analysis-runs/${f.run.id}/finalize`, original = structuredClone(f.artifacts);
  const first = await f.call(path, body); expect(first.status).toBe(200);
  const final = finalizationResponseSchema.parse(await first.json()).finalization!;
  expect(final.professorId).toBe(f.professor.id); expect(final.assessments[0]!.narrative).toBe(body.decisions[0]!.narrative);
  expect((await f.call(path, body)).status).toBe(200);
  expect(f.sqlite.query("SELECT * FROM professor_finalizations").all()).toHaveLength(1);
  expect(JSON.parse((f.sqlite.query("SELECT output_json FROM analysis_outputs").get() as any).output_json)).toEqual(original);
  expect(f.sqlite.query("SELECT * FROM audit_events WHERE action='analysis.finalize'").all()).toHaveLength(1);
  expect(finalizationResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/finalization`)).json()).finalization?.confirmedAt).toBe(final.confirmedAt);
  expect(() => f.sqlite.run("UPDATE professor_finalizations SET confirmed_at=0")).toThrow();
});
test("two tabs cannot overwrite one finalization; version/hash/missing acknowledgement and duplicate rows fail", async () => {
  const body = await finalRequest(f), path = `analysis-runs/${f.run.id}/finalize`;
  for (const bad of [{ ...body, expectedRunVersion: 99 }, { ...body, artifactHash: "f".repeat(64) }, { ...body, reviewedEvidenceIds: [] },
    { ...body, decisions: [...body.decisions, ...body.decisions] }]) expect((await f.call(path, bad)).status).toBe(409);
  const responses = await Promise.all([f.call(path, body), f.call(path, { ...body, requestId: crypto.randomUUID() })]);
  expect(responses.map(r => r.status).sort()).toEqual([200,409]); expect(f.sqlite.query("SELECT * FROM professor_finalizations").all()).toHaveLength(1);
});
test("other professor, incomplete run, source change and withdrawal cannot finalize", async () => {
  const body = await finalRequest(f), path = `analysis-runs/${f.run.id}/finalize`;
  f.setProfessor(professors[1]!); expect((await f.call(path, body)).status).toBe(404); f.setProfessor(f.professor);
  f.sqlite.run("UPDATE analysis_runs SET status='review' WHERE id=?", [f.run.id]); expect((await f.call(path, body)).status).toBe(409);
  f.sqlite.run("UPDATE analysis_runs SET status='awaiting_professor' WHERE id=?", [f.run.id]); f.edit(); expect((await f.call(path, body)).status).toBe(409);
  expect(f.sqlite.query("SELECT * FROM professor_finalizations").all()).toHaveLength(0);
});
test("finalized source invalidation blocks reuse and expiry erases the related human audit", async () => {
  const body = await finalRequest(f); expect((await f.call(`analysis-runs/${f.run.id}/finalize`, body)).status).toBe(200);
  f.sqlite.run("UPDATE consents SET status='withdrawn', recorded_at=?", [f.now()]);
  expect((await f.call(`analysis-runs/${f.run.id}/finalization`)).status).toBe(409);
  expect((await f.call(`analysis-runs/${f.run.id}/finalize`, body)).status).toBe(409);
  await requestErasure(f.db, f.teamId, "request", f.now()); await purgeTeam(f.db, f.teamId, f.now());
  expect(f.sqlite.query("SELECT * FROM professor_finalizations").all()).toHaveLength(0);
  expect(f.sqlite.query("PRAGMA foreign_key_check").all()).toHaveLength(0);
});
test("Slack outage never finalizes, and source-copy narratives cannot create permanent raw archives", async () => {
  const body = await finalRequest(f), path = `analysis-runs/${f.run.id}/finalize`;
  body.decisions[0]!.narrative = f.text; expect((await f.call(path, body)).status).toBe(409);
  body.decisions[0]!.narrative = "교수의 정성 판단"; f.outage(); expect((await f.call(path, body)).status).toBe(503);
});
test("withdrawal between verification and final write aborts status, human decision and audit together", async () => {
  const body = await finalRequest(f);
  const db = { ...f.db, batch: async (statements: any[]) => {
    if (statements.some(s => s.sql?.includes("INSERT INTO professor_finalizations"))) f.sqlite.run("UPDATE consents SET status='withdrawn',recorded_at=?", [f.now()]);
    return f.db.batch(statements as any);
  } };
  const response = await f.app.request(`https://synthetic/v1/analysis-runs/${f.run.id}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { ...f.env, DB: db });
  expect(response.status).toBe(409); expect(f.sqlite.query("SELECT * FROM professor_finalizations").all()).toHaveLength(0);
  expect(f.sqlite.query("SELECT * FROM audit_events WHERE action='analysis.finalize'").all()).toHaveLength(0);
});
