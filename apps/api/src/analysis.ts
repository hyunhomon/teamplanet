import { Hono, type Context } from "hono";
import type { Queue } from "@cloudflare/workers-types";
import { analysisRunResponseSchema, analysisDashboardSchema, analysisPreviewRequestSchema, analysisRunListSchema, createAnalysisRunSchema, jobKey, rubricSelectionSchema, runIdSchema, teamIdSchema, type QueueEnvelope } from "@teamplanet/contracts";
import { loadSpec, outboxInsert, snapshot, type Spec } from "@teamplanet/analysis";
import { processingWriteGuard, runValidityGuard, sha256Hex, validConsentSql } from "@teamplanet/collection";
import { dispatchJob, JobStore } from "@teamplanet/queue";
import { apiError, parseBody } from "./errors";
import { owned, type ProtectedEnv } from "./guard";
import { analysisEligibility, eligibilityError } from "./analysis-eligibility";
type Env = { Bindings: ProtectedEnv["Bindings"] & { WORK_QUEUE?: Queue<QueueEnvelope> }; Variables: ProtectedEnv["Variables"] };
export function analysisRoutes(now: () => number) {
  const routes = new Hono<Env>();
  const missing = (c: Context) => apiError(c, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
  async function response(c: Context<Env>, spec: Spec) {
    const db = c.env.DB; let valid = false;
    if (spec.manifest_json && spec.status !== "cancelled") { try { await runValidityGuard(db, spec.run_id, now()).run(); valid = true; } catch {} }
    const progress = await db.prepare(`SELECT (SELECT COUNT(*) FROM analysis_sources WHERE run_id = ?) AS sources,
      (SELECT COUNT(*) FROM analysis_chunks WHERE run_id = ?) AS chunks,
      (SELECT COUNT(*) FROM analysis_stage_results WHERE run_id = ? AND stage = 'evidence_extraction') AS completedChunks`).bind(spec.run_id, spec.run_id, spec.run_id).first<any>();
    const jobs = await db.prepare("SELECT status, error_code FROM queue_jobs WHERE json_extract(job_json,'$.runId') = ? AND error_code IS NOT NULL").bind(spec.run_id).all<any>();
    const errors = jobs.results.map(job => ({ code: job.error_code === "HANDLER_UNREGISTERED" ? "HANDLER_UNREGISTERED" : job.error_code === "DATA_INVALIDATED" ? "DATA_INVALIDATED" : "JOB_FAILED", retryable: job.status === "retry" }));
    const invalid = spec.manifest_json !== null && !valid && spec.status !== "cancelled";
    if (invalid) errors.push({ code: "DATA_INVALIDATED", retryable: false });
    return analysisRunResponseSchema.parse({ id: spec.run_id, teamId: spec.team_id, from: spec.from_ts, to: spec.to_ts, timezone: spec.timezone,
      status: invalid ? "failed_data" : spec.status, snapshot: JSON.parse(spec.snapshot_json), manifest: valid ? JSON.parse(spec.manifest_json!) : null,
      valid, progress, errors, version: spec.version });
  }
  routes.get("/analysis-dashboard", async c => {
    const rows = await c.env.DB.prepare(`SELECT t.*, c.name AS course_name, c.starts_at, c.ends_at, r.rubric_version, r.selected_competencies_json,
      (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members,
      (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id AND ${validConsentSql("m.team_id", "m.student_id")}) AS confirmed,
      (SELECT COUNT(*) FROM consents p WHERE p.team_id = t.id AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = p.team_id AND m.student_id = p.student_id)) AS unmapped
      FROM teams t JOIN courses c ON c.id = t.course_id LEFT JOIN course_rubric_settings r ON r.course_id = c.id
      WHERE c.professor_id = ? ORDER BY c.name, t.name, t.id`).bind(c.get("professor").id).all<any>();
    return c.json(analysisDashboardSchema.parse({ teams: rows.results.map(row => {
      let selected: unknown; try { selected = JSON.parse(row.selected_competencies_json ?? "null"); } catch { selected = null; }
      const selection = rubricSelectionSchema.safeParse({ rubricVersion: row.rubric_version, selectedCompetencies: selected });
      return { team: { id: row.id, courseId: row.course_id, workspaceId: row.workspace_id, channelId: row.channel_id, name: row.name, collectionStatus: row.collection_status },
        courseName: row.course_name, startsAt: row.starts_at === null ? null : new Date(row.starts_at).toISOString(), endsAt: row.ends_at === null ? null : new Date(row.ends_at).toISOString(),
        selection: selection.success ? selection.data : null, members: row.members, confirmed: row.confirmed, unmapped: row.unmapped };
    }) }));
  });
  routes.post("/analysis-preview", async c => {
    const parsed = await parseBody(c, analysisPreviewRequestSchema); if (parsed.error) return parsed.error;
    const result = await analysisEligibility(c, parsed.data, now());
    return result ? c.json(result.preview) : missing(c);
  });
  routes.get("/teams/:teamId/analysis-runs", async c => {
    const id = teamIdSchema.safeParse(c.req.param("teamId")); if (!id.success) return apiError(c, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(c, "team", id.data)) return missing(c);
    const before = c.req.query("before");
    if (before !== undefined && (!/^[1-9][0-9]{0,9}$/.test(before) || !Number.isSafeInteger(Number(before)))) return apiError(c, "VALIDATION_ERROR", "페이지 형식을 확인하세요.");
    const rows = await c.env.DB.prepare(`SELECT s.*, r.from_ts, r.to_ts, r.status FROM analysis_specs s JOIN analysis_runs r ON r.id = s.run_id
      WHERE s.team_id = ? AND s.professor_id = ? AND (? IS NULL OR s.version < ?) ORDER BY s.version DESC LIMIT 21`)
      .bind(id.data, c.get("professor").id, before ? Number(before) : null, before ? Number(before) : null).all<Spec>();
    const page = rows.results.slice(0, 20), runs = await Promise.all(page.map(spec => response(c, spec)));
    return c.json(analysisRunListSchema.parse({ teamId: id.data, runs, nextBefore: rows.results.length > 20 ? page.at(-1)!.version : null }));
  });
  routes.post("/analysis-runs", async c => {
    const input = await parseBody(c, createAnalysisRunSchema); if (input.error) return input.error;
    const { teamId, from, to, timezone, idempotencyKey } = input.data, db = c.env.DB, professor = c.get("professor").id;
    const hash = await sha256Hex(JSON.stringify({ teamId, from, to, timezone }));
    const existing = await db.prepare("SELECT run_id, request_hash FROM analysis_specs WHERE professor_id = ? AND idempotency_key = ?").bind(professor, idempotencyKey).first<any>();
    if (existing) return existing.request_hash !== hash ? apiError(c, "CONFLICT", "같은 요청 키의 입력이 다릅니다.") : c.json(await response(c, (await loadSpec(db, existing.run_id))!), 202);
    const a = Date.parse(from), b = Date.parse(to), at = now();
    const eligibility = await analysisEligibility(c, { teamId, from, to, timezone }, at); if (!eligibility) return missing(c);
    if (!eligibility.preview.allowed || !eligibility.selection) return eligibilityError(c, eligibility.preview.reasons);
    const { config, selection } = eligibility;
    const students = await db.prepare("SELECT s.id, s.display_name AS displayName FROM students s JOIN team_members m ON m.student_id = s.id WHERE m.team_id = ? ORDER BY s.id").bind(teamId).all<any>();
    const runId = `run_${crypto.randomUUID()}`, job = { kind: "analysis.prepare" as const, runId };
    try { await db.batch([
      processingWriteGuard(db, { teamId, from: a, to: b, now: now() }),
      db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM collection_coverage WHERE team_id = ? AND from_ms <= ? AND to_ms >= ? AND status = 'complete')
        AND EXISTS (SELECT 1 FROM message_refs WHERE team_id = ? AND deleted_at IS NULL AND CAST(slack_ts AS REAL) * 1000 >= ? AND CAST(slack_ts AS REAL) * 1000 < ?)
        THEN '1' ELSE 'coverage_changed' END)`).bind(teamId, a, b, teamId, a, b),
      db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM teams t JOIN courses c ON c.id = t.course_id JOIN course_rubric_settings r ON r.course_id = c.id
        WHERE t.id = ? AND c.professor_id = ? AND c.starts_at <= ? AND c.ends_at >= ? AND r.rubric_version = ? AND r.selected_competencies_json = ? AND r.updated_at = ?)
        AND ? = (SELECT json_group_array(json_object('id', id, 'displayName', display_name)) FROM
          (SELECT s.id, s.display_name FROM students s JOIN team_members m ON m.student_id = s.id WHERE m.team_id = ? ORDER BY s.id))
        THEN '1' ELSE 'config_changed' END)`).bind(teamId, professor, a, b, config.rubric_version, config.selected_competencies_json, config.rubric_updated, JSON.stringify(students.results), teamId),
      db.prepare(`INSERT INTO analysis_runs (id, team_id, from_ts, to_ts, status, created_by) SELECT ?, ?, ?, ?, 'queued', ?
        WHERE NOT EXISTS (SELECT 1 FROM analysis_specs WHERE professor_id = ? AND idempotency_key = ?)`).bind(runId, teamId, from, to, professor, professor, idempotencyKey),
      db.prepare(`INSERT INTO analysis_specs (run_id, team_id, professor_id, idempotency_key, request_hash, version, timezone, created_at, snapshot_json, students_json)
        SELECT ?, ?, ?, ?, ?, COALESCE((SELECT MAX(version) FROM analysis_specs WHERE team_id = ?),0)+1, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM analysis_runs WHERE id = ?)`).bind(runId, teamId, professor, idempotencyKey, hash, teamId, timezone, at, JSON.stringify(snapshot(selection)), JSON.stringify(students.results), runId),
      db.prepare(`INSERT INTO queue_jobs (job_key, job_json, created_at, updated_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM analysis_runs WHERE id = ?)`)
        .bind(jobKey(job), JSON.stringify(job), at, at, runId),
      db.prepare("INSERT INTO audit_events (actor_professor_id, action, target_type, target_id, result, recorded_at) SELECT ?, 'analysis.create', 'run', ?, 'succeeded', ? WHERE EXISTS (SELECT 1 FROM analysis_runs WHERE id = ?)").bind(professor, runId, at, runId),
    ]); } catch { return apiError(c, "CONFLICT", "분석 설정이나 동의가 변경되었습니다. 다시 조회하세요."); }
    const winner = (await db.prepare("SELECT run_id, request_hash FROM analysis_specs WHERE professor_id = ? AND idempotency_key = ?").bind(professor, idempotencyKey).first<any>())!;
    if (winner.request_hash !== hash) return apiError(c, "CONFLICT", "같은 요청 키의 입력이 다릅니다.");
    const store = new JobStore(db, now);
    if (c.env.WORK_QUEUE) { try { await dispatchJob(store, c.env.WORK_QUEUE, (await store.get(`prepare:${winner.run_id}`))!); } catch {} } // durable outbox retries independently
    return c.json(await response(c, (await loadSpec(db, winner.run_id))!), 202);
  });
  routes.get("/analysis-runs/:id", async c => {
    const id = runIdSchema.safeParse(c.req.param("id")); if (!id.success) return apiError(c, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(c, "run", id.data)) return missing(c);
    const spec = await loadSpec(c.env.DB, id.data); return spec ? c.json(await response(c, spec)) : missing(c);
  });
  routes.post("/analysis-runs/:id/cancel", async c => {
    const id = c.req.param("id"); if (!await owned(c, "run", id)) return missing(c);
    const db = c.env.DB;
    const current = await loadSpec(db, id);
    if (!current) return missing(c);
    if (["awaiting_professor", "finalized"].includes(current.status)) return apiError(c, "CONFLICT", "교수 검토 단계 실행은 취소할 수 없습니다.");
    await db.batch([db.prepare("UPDATE analysis_runs SET status = 'cancelled' WHERE id = ? AND status NOT IN ('awaiting_professor','finalized')").bind(id),
      db.prepare(`UPDATE queue_jobs SET status = 'dead', error_code = 'CANCELLED', lease_token = NULL, lease_until = NULL WHERE json_extract(job_json,'$.runId') = ?
        AND status IN ('pending','running','retry') AND EXISTS (SELECT 1 FROM analysis_runs WHERE id = ? AND status = 'cancelled')`).bind(id, id)]);
    const spec = await loadSpec(db, id); return spec ? c.json(await response(c, spec)) : missing(c);
  });
  routes.post("/analysis-runs/:id/resume", async c => {
    const id = c.req.param("id"); if (!await owned(c, "run", id)) return missing(c);
    const db = c.env.DB, spec = await loadSpec(db, id);
    if (!spec || ["cancelled", "failed_data", "finalized", "awaiting_professor"].includes(spec.status)) return apiError(c, "CONFLICT", "이 실행은 재개할 수 없습니다. 새 실행이 필요합니다.");
    try {
      if (spec.manifest_json) await runValidityGuard(db, id, now()).run();
      else await processingWriteGuard(db, { teamId: spec.team_id, from: Date.parse(spec.from_ts), to: Date.parse(spec.to_ts), now: now() }).run();
      const jobs = await db.prepare("SELECT job_key, generation FROM queue_jobs WHERE json_extract(job_json,'$.runId') = ? AND status = 'dead' AND error_code IN ('HANDLER_UNREGISTERED','UPSTREAM_UNAVAILABLE','HANDLER_FAILURE','ATTEMPTS_EXHAUSTED','DELIVERY_EXHAUSTED') AND generation < 3").bind(id).all<any>();
      if (!jobs.results.length && await db.prepare("SELECT 1 FROM queue_jobs WHERE json_extract(job_json,'$.runId') = ? AND status = 'dead'").bind(id).first()) return apiError(c, "CONFLICT", "재개할 수 없는 작업입니다. 새 실행이 필요합니다.");
      await db.batch([...(spec.manifest_json ? [runValidityGuard(db, id, now())] : [processingWriteGuard(db, { teamId: spec.team_id, from: Date.parse(spec.from_ts), to: Date.parse(spec.to_ts), now: now() })]),
        ...jobs.results.map(job => db.prepare("INSERT INTO job_recoveries (job_key, generation, reason_ref, recorded_at) VALUES (?, ?, ?, ?)").bind(job.job_key, job.generation + 1, `run-resume:${id}`, now()))]);
    } catch { return apiError(c, "CONFLICT", "현재 입력이 무효이거나 재개 한도를 넘었습니다."); }
    return c.json(await response(c, (await loadSpec(db, id))!), 202);
  });
  return routes;
}
