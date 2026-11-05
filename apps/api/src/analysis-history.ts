import { Hono, type Context } from "hono";
import type { Queue } from "@cloudflare/workers-types";
import { analysisHistoryRequestSchema, analysisHistoryResponseSchema, jobKey, queueJobSchema, teamIdSchema, type QueueEnvelope } from "@teamplanet/contracts";
import { collectionGate, processingWriteGuard } from "@teamplanet/collection";
import { dispatchJob, JobStore } from "@teamplanet/queue";
import { owned, type ProtectedEnv } from "./guard";
import { apiError, parseBody } from "./errors";
import { analysisEligibility, eligibilityError } from "./analysis-eligibility";
type Env = { Bindings: ProtectedEnv["Bindings"] & { WORK_QUEUE?: Queue<QueueEnvelope> }; Variables: ProtectedEnv["Variables"] };
export function analysisHistoryRoutes(now: () => number) {
  const routes = new Hono<Env>();
  const missing = (c: Context) => apiError(c, "NOT_FOUND", "수집 확인 요청을 찾을 수 없습니다.");
  async function read(c: Context<Env>, teamId: string, requestId: string) {
    const key = jobKey({ kind: "slack.history", teamId, requestId, fromMs: 0, toMs: 1 });
    const row = await c.env.DB.prepare(`SELECT j.job_json,j.status,j.error_code,c.status AS coverage FROM queue_jobs j
      LEFT JOIN collection_coverage c ON c.request_id = ? AND c.team_id = ? WHERE j.job_key = ?`).bind(requestId, teamId, key)
      .first<{ job_json: string; status: string; error_code: string | null; coverage: string | null }>();
    if (!row) return missing(c);
    const job = JSON.parse(row.job_json);
    return c.json(analysisHistoryResponseSchema.parse({ requestId, teamId, from: new Date(job.fromMs).toISOString(), to: new Date(job.toMs).toISOString(),
      status: row.status, coverage: row.coverage ?? "missing", errorCode: row.error_code }));
  }
  routes.post("/analysis-history", async c => {
    const parsed = await parseBody(c, analysisHistoryRequestSchema); if (parsed.error) return parsed.error;
    const input = parsed.data, db = c.env.DB;
    const { requestId: _requestId, ...previewInput } = input;
    const eligibility = await analysisEligibility(c, previewInput, now()); if (!eligibility) return missing(c);
    const reasons = eligibility.preview.reasons.filter(r => r !== "COVERAGE_INCOMPLETE" && r !== "NO_DATA");
    if (reasons.length) return eligibilityError(c, reasons);
    const gate = await collectionGate(db, { teamId: input.teamId, at: now(), now: now() });
    if (!gate.allowed) return apiError(c, "CONSENT_REQUIRED", "현재 동의와 수집 활성화 상태를 확인하세요.");
    const job = queueJobSchema.parse({ kind: "slack.history", teamId: input.teamId, requestId: input.requestId, fromMs: Date.parse(input.from), toMs: Date.parse(input.to) });
    if (job.kind !== "slack.history") throw new Error("HISTORY_JOB_INVALID");
    const key = jobKey(job), json = JSON.stringify(job);
    try { await db.batch([
      processingWriteGuard(db, { teamId: input.teamId, from: job.fromMs, to: job.toMs, now: now() }),
      db.prepare(`SELECT json(CASE WHEN NOT EXISTS (SELECT 1 FROM queue_jobs WHERE json_extract(job_json,'$.kind')='slack.history'
        AND json_extract(job_json,'$.requestId')=? AND job_key<>?)
        AND NOT EXISTS (SELECT 1 FROM collection_coverage WHERE request_id=? AND (team_id<>? OR from_ms<>? OR to_ms<>?))
        THEN '1' ELSE 'request_changed' END)`).bind(input.requestId,key,input.requestId,input.teamId,job.fromMs,job.toMs),
      db.prepare("SELECT json(CASE WHEN NOT EXISTS (SELECT 1 FROM queue_jobs WHERE job_key=? AND job_json<>?) THEN '1' ELSE 'request_changed' END)").bind(key, json),
      db.prepare(`INSERT INTO audit_events (actor_professor_id,action,target_type,target_id,result,recorded_at)
        SELECT ?, 'analysis.history_request', 'team', ?, 'succeeded', ? WHERE NOT EXISTS (SELECT 1 FROM queue_jobs WHERE job_key=?)`)
        .bind(c.get("professor").id,input.teamId,now(),key),
      db.prepare("INSERT INTO queue_jobs (job_key,job_json,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(job_key) DO NOTHING").bind(key, json, now(), now()),
    ]); } catch { return apiError(c, "CONFLICT", "기간이나 동의가 변경됐습니다. 다시 확인하세요."); }
    const store = new JobStore(db, now);
    if (c.env.WORK_QUEUE) { try { await dispatchJob(store, c.env.WORK_QUEUE, (await store.get(key))!); } catch {} }
    return read(c, input.teamId, input.requestId);
  });
  routes.get("/teams/:teamId/analysis-history/:requestId", async c => {
    const team = teamIdSchema.safeParse(c.req.param("teamId")), requestId = analysisHistoryRequestSchema.shape.requestId.safeParse(c.req.param("requestId"));
    if (!team.success || !requestId.success) return apiError(c, "VALIDATION_ERROR", "요청 ID를 확인하세요.");
    if (!await owned(c, "team", team.data)) return missing(c);
    return read(c, team.data, requestId.data);
  });
  return routes;
}
