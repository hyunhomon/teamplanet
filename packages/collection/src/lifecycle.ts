import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { participantsMappedSql, validConsentSql, pauseTeam } from "./index";

/** UTC calendar months, clamped to the last day of the target month. Never 90 days. */
export function retentionDeadline(endsAt: number) {
  const end = new Date(endsAt), target = new Date(endsAt);
  target.setUTCDate(1); target.setUTCMonth(target.getUTCMonth() + 3);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(end.getUTCDate(), last)); return target.getTime();
}
export const retentionDeadlineSql = (course: string) => `(
  unixepoch(${course}.ends_at / 1000, 'unixepoch', 'start of month', '+3 months') * 1000
  + (MIN(CAST(strftime('%d', ${course}.ends_at / 1000, 'unixepoch') AS INTEGER),
    CAST(strftime('%d', ${course}.ends_at / 1000, 'unixepoch', 'start of month', '+4 months', '-1 day') AS INTEGER)) - 1) * 86400000
  + (${course}.ends_at % 86400000))`;

/** Historical source use is distinct from new ingestion: consent still current, inside an allowed window, before retention expiry. */
export function processingWriteGuard(db: D1Database, input: { teamId: string; from: number; to?: number; now: number; authors?: readonly string[] }): D1PreparedStatement {
  return db.prepare(`SELECT json(CASE WHEN EXISTS (
    SELECT 1 FROM teams t JOIN courses c ON c.id = t.course_id JOIN team_data_versions v ON v.team_id = t.id
    WHERE t.id = ? AND v.blocked_at IS NULL AND v.purged_at IS NULL AND c.ends_at IS NOT NULL AND ${retentionDeadlineSql("c")} > ?
      AND (t.collection_status = 'active' OR (t.collection_status = 'paused' AND
        (SELECT end_reason FROM collection_windows WHERE team_id = t.id ORDER BY id DESC LIMIT 1) IN ('professor','course_ended')))
      AND EXISTS (SELECT 1 FROM consent_policies WHERE version = c.consent_version)
      AND EXISTS (SELECT 1 FROM collection_windows w WHERE w.team_id = t.id AND w.started_at <= ? AND (w.ended_at IS NULL OR (w.ended_at > ? AND w.ended_at >= ?)))
      AND ${participantsMappedSql("t.id")} AND EXISTS (SELECT 1 FROM team_members WHERE team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND NOT ${validConsentSql("m.team_id", "m.student_id")})
      AND NOT EXISTS (SELECT 1 FROM json_each(?) a WHERE NOT EXISTS (SELECT 1 FROM team_members m JOIN student_slack_mappings s ON s.student_id = m.student_id
        WHERE m.team_id = t.id AND s.slack_user_id = a.value))) THEN '1' ELSE 'data_use_blocked' END)`)
    .bind(input.teamId, input.now, input.from, input.from, input.to ?? input.from, JSON.stringify(input.authors ?? []));
}
export async function sourceAccess(db: D1Database, input: { teamId: string; at: number; now: number; slackUserId: string }) {
  try { await processingWriteGuard(db, { ...input, from: input.at, authors: [input.slackUserId] }).run(); } catch { return null; }
  return db.prepare(`SELECT m.student_id AS studentId FROM team_members m JOIN student_slack_mappings s ON s.student_id = m.student_id
    WHERE m.team_id = ? AND s.slack_user_id = ?`).bind(input.teamId, input.slackUserId).first<{ studentId: string }>();
}
export function dataEpochGuard(db: D1Database, teamId: string, epoch: number) {
  return db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM team_data_versions WHERE team_id = ? AND epoch = ? AND blocked_at IS NULL AND purged_at IS NULL)
    THEN '1' ELSE 'data_epoch_invalid' END)`).bind(teamId, epoch);
}
export function runValidityGuard(db: D1Database, runId: string, now: number) {
  return db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM analysis_runs r JOIN run_data_validity rv ON rv.run_id = r.id AND rv.team_id = r.team_id
    JOIN team_data_versions v ON v.team_id = r.team_id JOIN teams t ON t.id = r.team_id JOIN courses c ON c.id = t.course_id
    WHERE r.id = ? AND rv.invalidated_at IS NULL AND rv.data_epoch = v.epoch AND v.blocked_at IS NULL AND v.purged_at IS NULL
      AND EXISTS (SELECT 1 FROM consent_policies WHERE version = c.consent_version)
      AND ${participantsMappedSql("t.id")} AND EXISTS (SELECT 1 FROM team_members WHERE team_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND NOT ${validConsentSql("m.team_id", "m.student_id")})
      AND c.ends_at IS NOT NULL AND ${retentionDeadlineSql("c")} > ?) THEN '1' ELSE 'run_invalidated' END)`)
    .bind(runId, now);
}
/** Invalidates summaries as well as professor-finalized runs; no operation clears an invalidation. */
export function invalidateTeam(db: D1Database, teamId: string, reason: string, now: number) {
  return db.prepare("UPDATE team_data_versions SET epoch = epoch + 1, reason = ?, updated_at = ? WHERE team_id = ?")
    .bind(reason, now, teamId);
}
export async function observeSourceFailure(db: D1Database, target: { teamId: string; channelId: string; slackTs: string }, deleted: boolean, now: number) {
  await db.prepare(`UPDATE message_refs SET content_hash = NULL, deleted_at = CASE WHEN ? THEN COALESCE(deleted_at, ?) ELSE deleted_at END, updated_at = ?
    WHERE team_id = ? AND channel_id = ? AND slack_ts = ?`).bind(Number(deleted), now, now, target.teamId, target.channelId, target.slackTs).run();
}

export async function requestErasure(db: D1Database, teamId: string, reason: "request" | "retention", now: number, extra: D1PreparedStatement[] = []) {
  const id = `erasure_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`INSERT INTO data_erasure_jobs (id, team_id, reason, requested_at) VALUES (?, ?, ?, ?) ON CONFLICT(team_id) DO NOTHING`).bind(id, teamId, reason, now),
    db.prepare("UPDATE team_data_versions SET blocked_at = COALESCE(blocked_at, ?), epoch = epoch + 1, reason = 'erasure_requested', updated_at = ? WHERE team_id = ? AND blocked_at IS NULL").bind(now, now, teamId),
    ...pauseTeam(db, teamId, "professor", now), ...extra,
  ]);
  return db.prepare("SELECT * FROM data_erasure_jobs WHERE team_id = ?").bind(teamId).first();
}
/** Purge batches are transactional; a failed attempt retains blocked status and a fixed failure code. */
export async function purgeTeam(db: D1Database, teamId: string, now: number) {
  const job = await db.prepare(`UPDATE data_erasure_jobs SET status = 'processing', attempts = attempts + 1, next_attempt_at = ?
    WHERE team_id = ? AND status IN ('pending','failed','processing') AND attempts < 5 AND next_attempt_at <= ? RETURNING *`)
    .bind(now + 60_000, teamId, now).first<{ attempts: number }>();
  if (!job) return false;
  const runIds = "SELECT id FROM analysis_runs WHERE team_id = ?";
  const jobKeys = `SELECT job_key FROM queue_jobs WHERE json_extract(job_json,'$.teamId') = ?
    OR json_extract(job_json,'$.runId') IN (${runIds})
    OR json_extract(job_json,'$.eventRef') IN (SELECT event_ref FROM slack_event_refs WHERE team_id = ?)`;
  const jobArgs = [teamId, teamId, teamId];
  try {
    const writes: D1PreparedStatement[] = [db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM data_erasure_jobs
      WHERE team_id = ? AND attempts = ? AND status = 'processing') THEN '1' ELSE 'erasure_lease_lost' END)`).bind(teamId, job.attempts)];
    writes.push(db.prepare("DELETE FROM inquiry_effects WHERE team_id = ?").bind(teamId));
    for (const table of ["job_checkpoints", "job_failures", "job_recoveries"]) writes.push(db.prepare(`DELETE FROM ${table} WHERE job_key IN (${jobKeys})`).bind(...jobArgs));
    writes.push(db.prepare(`DELETE FROM queue_jobs WHERE job_key IN (${jobKeys})`).bind(...jobArgs));
    // Remove related audit records before referenced evidence/run rows disappear.
    writes.push(db.prepare(`DELETE FROM audit_events WHERE target_id = ? OR target_id IN (${runIds})
      OR target_id IN (SELECT id FROM evidence_events WHERE run_id IN (${runIds}))
      OR target_id IN (SELECT student_id FROM team_members WHERE team_id = ?)`)
      .bind(teamId, teamId, teamId, teamId));
    for (const table of ["assessments", "evidence_events", "run_data_validity"]) writes.push(db.prepare(`DELETE FROM ${table} WHERE run_id IN (${runIds})`).bind(teamId));
    writes.push(db.prepare("DELETE FROM analysis_runs WHERE team_id = ?").bind(teamId));
    for (const table of ["image_refs", "message_refs", "messages", "slack_event_refs", "collection_coverage", "data_invalidations"]) writes.push(db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).bind(teamId));
    writes.push(db.prepare("DELETE FROM consent_evidence WHERE history_id IN (SELECT id FROM consent_history WHERE team_id = ?)").bind(teamId));
    for (const table of ["consent_confirmations", "consents", "consent_history", "collection_windows"]) writes.push(db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).bind(teamId));
    writes.push(db.prepare("DELETE FROM data_invalidations WHERE team_id = ?").bind(teamId));
    writes.push(db.prepare("UPDATE team_data_versions SET purged_at = ?, reason = 'purged', updated_at = ? WHERE team_id = ?").bind(now, now, teamId));
    writes.push(db.prepare("UPDATE data_erasure_jobs SET status = 'completed', completed_at = ?, error_code = NULL WHERE team_id = ?").bind(now, teamId));
    await db.batch(writes);
    return true;
  } catch {
    await db.prepare("UPDATE data_erasure_jobs SET status = 'failed', error_code = 'ERASURE_FAILED', next_attempt_at = ? WHERE team_id = ? AND attempts = ? AND status = 'processing'")
      .bind(now + 2 ** job.attempts * 60_000, teamId, job.attempts).run();
    throw new Error("ERASURE_FAILED");
  }
}
export async function sweepDataRetention(db: D1Database, now: number) {
  await db.prepare("UPDATE data_erasure_jobs SET status = 'failed', error_code = 'ERASURE_FAILED' WHERE status = 'processing' AND attempts >= 5 AND next_attempt_at <= ?").bind(now).run();
  const { results } = await db.prepare(`SELECT t.id FROM teams t JOIN courses c ON c.id = t.course_id JOIN team_data_versions v ON v.team_id = t.id
    WHERE c.ends_at IS NOT NULL AND ${retentionDeadlineSql("c")} <= ? AND v.purged_at IS NULL LIMIT 50`).bind(now).all<{ id: string }>();
  for (const team of results) await requestErasure(db, team.id, "retention", now);
  const due = await db.prepare("SELECT team_id FROM data_erasure_jobs WHERE status <> 'completed' AND attempts < 5 AND next_attempt_at <= ? LIMIT 50").bind(now).all<{ team_id: string }>();
  const settled = await Promise.allSettled(due.results.map(job => purgeTeam(db, job.team_id, now)));
  // Receipts are not an exception to course-history retention. Keep only the team configuration's irreversible blocked/purged flag.
  await db.prepare(`DELETE FROM data_erasure_jobs WHERE status = 'completed' AND team_id IN (SELECT t.id FROM teams t JOIN courses c ON c.id = t.course_id
    WHERE c.ends_at IS NOT NULL AND ${retentionDeadlineSql("c")} <= ?)`).bind(now).run();
  if (settled.some(result => result.status === "rejected")) throw new Error("RETENTION_SWEEP_INCOMPLETE");
  return { completed: settled.filter(result => result.status === "fulfilled" && result.value).length };
}
