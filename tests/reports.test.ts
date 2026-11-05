import { afterEach, beforeEach, expect, test } from "bun:test";
import { resultFixture } from "./helpers/result";
import { resultResponseSchema, studentReportSchema } from "@teamplanet/contracts";
import { professors } from "@teamplanet/contracts/fixtures";
import { retentionDeadline } from "@teamplanet/collection";
import { createApp } from "../apps/api/src/index";
import { redactReportText } from "../apps/api/src/reports";
import { reconcileReview, withVerifiedArtifacts } from "@teamplanet/analysis";
let f: Awaited<ReturnType<typeof resultFixture>>;
beforeEach(async () => { f = await resultFixture(); }); afterEach(() => f.sqlite.close());
async function confirm() {
  const r = resultResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/assessments`)).json());
  const body = { requestId: crypto.randomUUID(), expectedRunVersion: r.version, artifactHash: r.artifactHash,
    decisions: r.artifacts.candidate.assessments.map(row => ({ studentId: row.studentId, key: row.key, judgement: row.judgement, narrative: "교수의 정성 피드백", reason: "원문과 한계를 검토함" })),
    reviewedStudentIds: r.students.map(s => s.id), reviewedEvidenceIds: r.artifacts.evidence.map(e => e.id), reviewedIssueIds: [], limitationsReviewed: true, finalDecisionConfirmed: true };
  expect((await f.call(`analysis-runs/${f.run.id}/finalize`, body)).status).toBe(200);
}
const path = () => `analysis-runs/${f.run.id}/reports/${f.studentId}`;
const printBody = (report: ReturnType<typeof studentReportSchema.parse>) => ({ artifactHash: report.artifactHash, professorConfirmedAt: report.professorConfirmedAt, privacyReviewed: true, requestId: crypto.randomUUID() });
test("only this student's finalized selected cards and summaries enter a verified print DTO", async () => {
  expect((await f.call(path())).status).toBe(409); await confirm();
  const report = studentReportSchema.parse(await (await f.call(path())).json());
  expect(report.cards.map(c => c.key)).toEqual(["clarity"]); expect(report.cards[0]!.narrative).toBe("교수의 정성 피드백");
  expect(report.cards[0]!.evidence[0]!.summary).toBe(f.artifacts.evidence[0]!.summary);
  expect(JSON.stringify(report)).not.toContain(f.text); expect(JSON.stringify(report)).not.toContain(f.slackTs); expect(JSON.stringify(report)).not.toContain("message_");
  expect((await f.call(path() + "/print", printBody(report))).status).toBe(200);
  expect(f.sqlite.query("SELECT * FROM audit_events WHERE action='analysis.report_print'").all()).toHaveLength(1);
});
test("another professor, unknown student, privacy check omission and stale preview cannot print", async () => {
  await confirm(); const report = studentReportSchema.parse(await (await f.call(path())).json());
  expect((await f.call(path()+"/print", { ...printBody(report), privacyReviewed: false })).status).toBe(400);
  expect((await f.call(path()+"/print", { ...printBody(report), artifactHash: "f".repeat(64) })).status).toBe(409);
  expect((await f.call(`analysis-runs/${f.run.id}/reports/student_00000000-0000-4000-8000-000000009999`)).status).toBe(404);
  f.setProfessor(professors[1]!); expect((await f.call(path())).status).toBe(404);
});
for (const action of ["edit", "deleteSource", "outage"] as const) test(`print rechecks finalized sources: ${action} never prints stale output`, async () => {
  await confirm(); const report = studentReportSchema.parse(await (await f.call(path())).json()); f[action]();
  expect((await f.call(path()+"/print", printBody(report))).status).toBe(action === "outage" ? 503 : 409);
  expect(f.sqlite.query("SELECT * FROM audit_events WHERE action='analysis.report_print'").all()).toHaveLength(0);
});
test("withdrawal or retention deadline blocks a previously previewed report", async () => {
  await confirm(); const report = studentReportSchema.parse(await (await f.call(path())).json());
  const end = (f.sqlite.query("SELECT ends_at FROM courses WHERE id=?").get(f.course.id) as any).ends_at; f.setClock(retentionDeadline(end));
  expect((await f.call(path()+"/print", printBody(report))).status).toBe(409);
});
test("withdrawal racing print authorization rolls back the print audit", async () => {
  await confirm(); const report = studentReportSchema.parse(await (await f.call(path())).json());
  const db = { ...f.db, batch: async (statements: any[]) => {
    if (statements.some(s => s.sql?.includes("analysis.report_print"))) f.sqlite.run("UPDATE consents SET status='withdrawn',recorded_at=?", [f.now()]);
    return f.db.batch(statements as any);
  } };
  const response = await f.app.request(`https://synthetic/v1/${path()}/print`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(printBody(report)) }, { ...f.env, DB: db });
  expect(response.status).toBe(409); expect(f.sqlite.query("SELECT * FROM audit_events WHERE action='analysis.report_print'").all()).toHaveLength(0);
});
test("session/Origin guard protects the direct report URL and accidental identity/link disclosure is reduced", async () => {
  const server = createApp();
  const get = await server.request(`https://synthetic/v1/${path()}`, {}, f.env as any); expect(get.status).toBe(401); expect(get.headers.get("Cache-Control")).toBe("no-store");
  expect((await server.request(`https://synthetic/v1/${path()}/print`, { method: "POST", headers: { Origin: "https://other.invalid", "Content-Type": "application/json" }, body: "{}" }, f.env as any)).status).toBe(403);
  const text = redactReportText("다른합성학생이 peer@example.invalid https://example.invalid/private?token=synthetic <@USYNTH0001> 자료를 공유했다.", ["다른합성학생"]);
  expect(text).not.toContain("peer@"); expect(text).not.toContain("token"); expect(text).not.toContain("USYNTH"); expect(text).toContain("다른 참가자");
});
test("C's aggregate limitations never copy another student's individual assessment into the printable report", async () => {
  f.sqlite.close(); const otherAssessment = "다른 학생의 개별 비공개 판단은 이 리포트에 포함하지 않는다."; f = await resultFixture(1, otherAssessment);
  expect(JSON.stringify(f.artifacts)).toContain(otherAssessment); await confirm();
  const report = studentReportSchema.parse(await (await f.call(path())).json());
  expect(JSON.stringify(report)).not.toContain(otherAssessment); expect(report.cards[0]!.limitations).toContain("단일 합성 관찰");
});
test("A's chunk-wide free-text limitations do not leak unrelated observations to a student's report", async () => {
  f.sqlite.close(); const unrelated = "다른 참가자의 별도 묶음에서 관찰된 비공개 한계";
  f = await resultFixture(1, undefined, unrelated); await confirm();
  const report = studentReportSchema.parse(await (await f.call(path())).json());
  expect(JSON.stringify(report)).not.toContain(unrelated);
  expect(report.cards[0]!.limitations).toContain("단일 합성 관찰");
  expect(report.reviewLimitations.some(l => l.includes("팀 전체 한계"))).toBe(true);
});
test("a B correction cannot erase this student's original uncertainty from the printable report", async () => {
  const artifacts = await withVerifiedArtifacts(f.deps(), f.run.id, async (a, input) => {
    const original = structuredClone(a.originalAssessment); original.assessments[0]!.limitations.push("원래 교수 검토가 필요한 관찰 한계");
    const first = { ...a.firstReview, decision: "request_correction", issues: [{ id: "issue_scope", code: "context_missing", studentId: f.studentId,
      competency: "clarity", evidenceIds: [a.evidence[0]!.id], messageIds: a.evidence[0]!.messageIds, instruction: "관찰 범위 한계를 확인하세요." }] };
    const corrected = structuredClone(original); corrected.assessments[0]!.limitations = ["수정 후 남은 한계"];
    const correction = { version: "analysis-stages-v1", iteration: 1, resolvedIssueIds: ["issue_scope"], assessment: corrected };
    const history = await reconcileReview({ ...input, assessment: original, iteration: 0 }, first, correction, { ...a.finalReview, iteration: 1 });
    return { ...a, originalAssessment: history.originalAssessment, firstReview: history.firstReview, correction: history.correction,
      finalReview: history.finalReview!, candidate: history.candidate!, requiresHumanReview: history.requiresHumanReview };
  });
  f.sqlite.run("UPDATE analysis_outputs SET output_json=? WHERE run_id=?", [JSON.stringify(artifacts), f.run.id]);
  const r = resultResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/assessments`)).json());
  const body = { requestId: crypto.randomUUID(), expectedRunVersion: r.version, artifactHash: r.artifactHash,
    decisions: r.artifacts.candidate.assessments.map(row => ({ studentId: row.studentId, key: row.key, judgement: row.judgement, narrative: "교수의 정성 피드백", reason: "원문과 한계를 검토함" })),
    reviewedStudentIds: r.students.map(s => s.id), reviewedEvidenceIds: r.artifacts.evidence.map(e => e.id), reviewedIssueIds: ["issue_scope"], limitationsReviewed: true, finalDecisionConfirmed: true };
  expect((await f.call(`analysis-runs/${f.run.id}/finalize`, body)).status).toBe(200);
  const report = studentReportSchema.parse(await (await f.call(path())).json());
  expect(report.cards[0]!.limitations).toContain("원래 교수 검토가 필요한 관찰 한계");
  expect(report.cards[0]!.limitations).toContain("수정 후 남은 한계");
});
