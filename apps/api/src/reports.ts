import { Hono, type Context } from "hono";
import { studentIdSchema, runIdSchema, studentReportSchema, printStudentReportSchema, assessmentSetSchema, type StudentReport } from "@teamplanet/contracts";
import { withVerifiedArtifacts } from "@teamplanet/analysis";
import { runValidityGuard, sha256Hex, type ImageDeps } from "@teamplanet/collection";
import { owned, type ProtectedEnv } from "./guard";
import { parseBody, apiError } from "./errors";
import { resultFailure } from "./results";
import { savedFinalization } from "./finalization";
type Env = { Bindings: ProtectedEnv["Bindings"] & { SLACK_TOKEN_KEY?: string }; Variables: ProtectedEnv["Variables"] };
export function redactReportText(value: string, otherNames: readonly string[]) {
  let text = value;
  for (const name of otherNames) text = text.split(name).join("다른 참가자");
  return text.replace(/https?:\/\/\S+/g, "[외부 링크 생략]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[연락처 생략]")
    .replace(/<[@#][^>]+>/g, "[참가자·채널 참조 생략]").replace(/\b(?:student|message|evidence|run)_[0-9a-f-]{36}\b/g, "[내부 참조 생략]");
}
export function reportRoutes(now: () => number, send: ImageDeps["send"]) {
  const routes = new Hono<Env>();
  async function report(c: Context<Env>, printing: boolean) {
    const runId = runIdSchema.safeParse(c.req.param("id")), studentId = studentIdSchema.safeParse(c.req.param("studentId"));
    if (!runId.success || !studentId.success) return apiError(c, "VALIDATION_ERROR", "실행·학생 ID를 확인하세요.");
    if (!await owned(c, "run", runId.data)) return apiError(c, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    const body = printing ? await parseBody(c, printStudentReportSchema) : null; if (body?.error) return body.error;
    const deps: ImageDeps = { db: c.env.DB, now, send, tokenKey: c.env.SLACK_TOKEN_KEY };
    try { return await withVerifiedArtifacts(deps, runId.data, async (a, input, spec, current) => {
      const student = input.students.find(s => s.id === studentId.data); if (!student) return apiError(c, "NOT_FOUND", "이 실행의 학생이 아닙니다.");
      const finalization = await savedFinalization(c.env.DB, runId.data), artifactHash = await sha256Hex(JSON.stringify(a));
      if (spec.status !== "finalized" || !finalization || finalization.artifactHash !== artifactHash || finalization.runId !== runId.data
        || finalization.runVersion !== spec.version || finalization.professorId !== c.get("professor").id) return apiError(c, "CONFLICT", "교수 확정과 현재 근거 검증이 완료된 결과만 출력할 수 있습니다.");
      assessmentSetSchema(a.snapshot.rubric, input.students.map(s => s.id), a.evidence.map(e => e.id)).parse(finalization.assessments);
      if (body?.data && (body.data.artifactHash !== artifactHash || body.data.professorConfirmedAt !== finalization.confirmedAt)) return apiError(c, "CONFLICT", "미리보기 버전이 바뀌었습니다. 다시 검증하고 확인하세요.");
      // Only this student's cards. Source text, message links and other students' assessments never enter printable content.
      const otherNames = input.students.filter(s => s.id !== studentId.data && s.displayName !== student.displayName).map(s => s.displayName).filter(Boolean).sort((x,y) => y.length-x.length);
      const clean = (value: string) => redactReportText(value, otherNames);
      // C's aggregate limitations may mention other students; take only this student's pre-aggregation B rows.
      const scopedAssessment = a.correction?.assessment ?? a.originalAssessment;
      const overview = scopedAssessment.overviews.find(o => o.studentId === studentId.data)!;
      const course = (await c.env.DB.prepare("SELECT c.name FROM courses c JOIN teams t ON t.course_id=c.id WHERE t.id=?").bind(spec.team_id).first<{ name: string }>())!;
      const value: StudentReport = studentReportSchema.parse({ runId: runId.data, studentId: studentId.data, studentDisplayName: student.displayName, courseName: course.name,
        runVersion: spec.version, artifactHash, rubricVersion: a.snapshot.rubric.rubricVersion, from: spec.from_ts, to: spec.to_ts,
        verifiedAt: new Date(now()).toISOString(), professorConfirmedAt: finalization.confirmedAt, overview: clean(overview.summary), overviewLimitations: overview.limitations.map(clean),
        cards: finalization.assessments.filter(r => r.studentId === studentId.data).map(row => {
          const ai = scopedAssessment.assessments.find(r => r.studentId === row.studentId && r.key === row.key)!;
          const ownEvents = [...row.evidenceIds, ...row.counterEvidenceIds].map(id => a.evidence.find(e => e.id === id)!);
          return { key: row.key, judgement: row.judgement, narrative: clean(row.narrative), reason: clean(finalization.decisions.find(d => d.studentId === row.studentId && d.key === row.key)!.reason),
            aiJudgement: ai.judgement, aiConfidence: ai.confidence, limitations: [...new Set([...input.limitations, ...ai.limitations, ...ownEvents.flatMap(e => e.limitations)])].map(clean), aiRequestedHumanReview: row.requiresHumanReview,
            evidence: [...row.evidenceIds.map(id => ({ id, kind: "support" as const })), ...row.counterEvidenceIds.map(id => ({ id, kind: "counter" as const }))].map(ref => {
              const event = a.evidence.find(e => e.id === ref.id)!; return { kind: ref.kind, summary: clean(event.summary), limitations: event.limitations.map(clean) };
            }) };
        }), unresolvedIssues: a.finalReview.issues.filter(i => i.studentId === studentId.data).map(i => clean(i.instruction)),
        reviewLimitations: [...new Set([...input.limitations, ...overview.limitations, ...scopedAssessment.assessments.filter(r => r.studentId === studentId.data).flatMap(r => r.limitations)])].map(clean),
        purpose: "성적 반영을 위한 자동 점수나 순위가 아닌, 관찰 범위 안의 교수 참고·피드백 자료입니다.",
        correctionNotice: "이미 전달한 파일·종이는 자동 회수되지 않습니다. 원문 변경·철회·보관 만료 시 이전 버전의 정정·재전달 필요를 확인하세요." });
      await current();
      await c.env.DB.batch([runValidityGuard(c.env.DB, runId.data, now()),
        c.env.DB.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM analysis_runs r JOIN professor_finalizations f ON f.run_id=r.id
          JOIN analysis_outputs o ON o.run_id=r.id WHERE r.id=? AND r.status='finalized' AND f.payload_json=? AND o.output_json=?) THEN '1' ELSE 'report_changed' END)`)
          .bind(runId.data, JSON.stringify(finalization), JSON.stringify(a)),
        ...(printing ? [c.env.DB.prepare("INSERT INTO audit_events (actor_professor_id,action,target_type,target_id,result,recorded_at) VALUES (?, 'analysis.report_print', 'run', ?, 'succeeded', ?)")
          .bind(c.get("professor").id, runId.data, now())] : []),
      ]);
      return c.json(value);
    }); } catch (error) { return resultFailure(c, error); }
  }
  routes.get("/analysis-runs/:id/reports/:studentId", c => report(c, false));
  routes.post("/analysis-runs/:id/reports/:studentId/print", c => report(c, true));
  return routes;
}
