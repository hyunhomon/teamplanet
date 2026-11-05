import { afterEach, beforeEach, expect, test } from "bun:test";
import { resultFixture } from "./helpers/result";
import { resultResponseSchema, studentReportSchema } from "@teamplanet/contracts";
import { professors } from "@teamplanet/contracts/fixtures";
import { retentionDeadline } from "@teamplanet/collection";
import { createApp } from "../apps/api/src/index";
import { redactReportText } from "../apps/api/src/reports";
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
