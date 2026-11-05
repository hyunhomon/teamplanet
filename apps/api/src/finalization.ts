import { Hono, type Context } from "hono";
import { assessmentSetSchema, finalizationResponseSchema, finalizeRequestSchema, professorFinalizationSchema, runIdSchema, type AnalysisArtifacts, type ProfessorFinalization } from "@teamplanet/contracts";
import { withVerifiedArtifacts } from "@teamplanet/analysis";
import { runValidityGuard, sha256Hex, type ImageDeps } from "@teamplanet/collection";
import { owned, type ProtectedEnv } from "./guard";
import { apiError, parseBody } from "./errors";
import { resultFailure } from "./results";
type Env = { Bindings: ProtectedEnv["Bindings"] & { SLACK_TOKEN_KEY?: string }; Variables: ProtectedEnv["Variables"] };
const sameSet = (values: string[], expected: string[]) => new Set(values).size === values.length && [...values].sort().join() === [...new Set(expected)].sort().join();
export const requiredIssues = (a: AnalysisArtifacts) => [...new Set([...a.firstReview.issues, ...a.finalReview.issues].map(i => i.id))];
export async function savedFinalization(db: ImageDeps["db"], runId: string): Promise<ProfessorFinalization | null> {
  const row = await db.prepare("SELECT payload_json FROM professor_finalizations WHERE run_id = ?").bind(runId).first<{ payload_json: string }>();
  return row ? professorFinalizationSchema.parse(JSON.parse(row.payload_json)) : null;
}
export function finalizationRoutes(now: () => number, send: ImageDeps["send"]) {
  const routes = new Hono<Env>(), deps = (c: Context<Env>): ImageDeps => ({ db: c.env.DB, now, send, tokenKey: c.env.SLACK_TOKEN_KEY });
  routes.get("/analysis-runs/:id/finalization", async c => {
    const id = runIdSchema.safeParse(c.req.param("id")); if (!id.success) return apiError(c, "VALIDATION_ERROR", "실행 ID를 확인하세요.");
    if (!await owned(c, "run", id.data)) return apiError(c, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    try { return await withVerifiedArtifacts(deps(c), id.data, async (a, _input, spec, current) => {
      const finalization = await savedFinalization(c.env.DB, id.data);
      if (spec.status === "finalized" && !finalization || finalization && (finalization.artifactHash !== await sha256Hex(JSON.stringify(a))
        || finalization.runId !== id.data || finalization.runVersion !== spec.version || finalization.professorId !== spec.professor_id)) throw Error("FINALIZATION_INVALID");
      await current(); return c.json(finalizationResponseSchema.parse({ runId: id.data, verifiedAt: new Date(now()).toISOString(), finalization }));
    }); } catch (error) { return resultFailure(c, error); }
  });
  routes.post("/analysis-runs/:id/finalize", async c => {
    const id = runIdSchema.safeParse(c.req.param("id")); if (!id.success) return apiError(c, "VALIDATION_ERROR", "실행 ID를 확인하세요.");
    if (!await owned(c, "run", id.data)) return apiError(c, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    const parsed = await parseBody(c, finalizeRequestSchema); if (parsed.error) return parsed.error;
    const body = parsed.data, db = c.env.DB, professorId = c.get("professor").id, requestHash = await sha256Hex(JSON.stringify(body));
    try { return await withVerifiedArtifacts(deps(c), id.data, async (a, input, spec, current) => {
      const hash = await sha256Hex(JSON.stringify(a));
      if (body.expectedRunVersion !== spec.version || body.artifactHash !== hash) return apiError(c, "CONFLICT", "분석 버전이나 검증된 결과가 바뀌었습니다. 최신 결과를 다시 검토하세요.");
      const existing = await db.prepare("SELECT request_id,request_hash,payload_json FROM professor_finalizations WHERE run_id = ?").bind(id.data).first<any>();
      if (existing) {
        if (existing.request_id !== body.requestId || existing.request_hash !== requestHash) return apiError(c, "CONFLICT", "이미 확정됐거나 다른 탭의 변경이 있습니다. 최신 결과를 조회하세요.");
        await current(); return c.json(finalizationResponseSchema.parse({ runId: id.data, verifiedAt: new Date(now()).toISOString(), finalization: JSON.parse(existing.payload_json) }));
      }
      if (spec.status !== "awaiting_professor") return apiError(c, "CONFLICT", "교수 검토 대기 상태에서만 확정할 수 있습니다.");
      if (!sameSet(body.reviewedStudentIds, input.students.map(s => s.id)) || !sameSet(body.reviewedEvidenceIds, a.evidence.map(e => e.id)) || !sameSet(body.reviewedIssueIds, requiredIssues(a))) return apiError(c, "CONFLICT", "학생·근거·이견·한계의 필수 검토 확인이 필요합니다.");
      const seen = new Set<string>();
      const assessments = body.decisions.map(d => {
        const key = `${d.studentId}:${d.key}`, original = a.candidate.assessments.find(r => r.studentId === d.studentId && r.key === d.key);
        if (!original || seen.has(key)) throw Error("INVALID_DECISION"); seen.add(key);
        for (const text of [d.narrative, d.reason]) for (const part of input.parts) {
          if (part.text.trim() && text === part.text.trim()) throw Error("RAW_SOURCE_COPY");
          if (part.text.length >= 12 && text.includes(part.text)) throw Error("RAW_SOURCE_COPY");
          for (let i = 0; i + 32 <= text.length; i++) if (part.text.includes(text.slice(i,i+32))) throw Error("RAW_SOURCE_COPY");
        }
        if (d.judgement === "mixed" && !original.counterEvidenceIds.length) throw Error("COUNTEREVIDENCE_REQUIRED");
        return { ...original, judgement: d.judgement, narrative: d.narrative };
      });
      assessmentSetSchema(a.snapshot.rubric, input.students.map(s => s.id), a.evidence.map(e => e.id)).parse(assessments);
      const payload = professorFinalizationSchema.parse({ runId: id.data, runVersion: spec.version, artifactHash: hash, professorId, requestId: body.requestId,
        confirmedAt: new Date(now()).toISOString(), decisions: body.decisions, assessments, reviewedStudentIds: body.reviewedStudentIds, reviewedEvidenceIds: body.reviewedEvidenceIds, reviewedIssueIds: body.reviewedIssueIds });
      await current();
      await db.batch([runValidityGuard(db, id.data, now()),
        db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM analysis_runs r JOIN analysis_specs s ON s.run_id = r.id JOIN analysis_outputs o ON o.run_id = r.id
          WHERE r.id = ? AND r.status = 'awaiting_professor' AND s.professor_id = ? AND s.version = ? AND o.output_json = ?)
          AND NOT EXISTS (SELECT 1 FROM professor_finalizations WHERE run_id = ?) THEN '1' ELSE 'finalization_conflict' END)`)
          .bind(id.data, professorId, spec.version, JSON.stringify(a), id.data),
        db.prepare("INSERT INTO professor_finalizations VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id.data, professorId, body.requestId, requestHash, hash, spec.version, JSON.stringify(payload), now()),
        db.prepare("UPDATE analysis_runs SET status = 'finalized' WHERE id = ? AND status = 'awaiting_professor'").bind(id.data),
        db.prepare("INSERT INTO audit_events (actor_professor_id,action,target_type,target_id,result,recorded_at) VALUES (?, 'analysis.finalize', 'run', ?, 'succeeded', ?)").bind(professorId, id.data, now()),
      ]);
      return c.json(finalizationResponseSchema.parse({ runId: id.data, verifiedAt: new Date(now()).toISOString(), finalization: payload }));
    }); } catch (error) { return resultFailure(c, error); }
  });
  return routes;
}
