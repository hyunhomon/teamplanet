import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

/**
 * Consent gate shared by the API (#8), Slack Events (#11) and History recovery (#12).
 * Every collection path asks this module at intake and again right before it stores anything.
 */
export type EndReason =
  | "professor" | "consent_changed" | "policy_changed" | "unknown_participant"
  | "member_left" | "bot_removed" | "slack_revoked" | "course_ended";
export type GateBlock =
  | "team_inactive" | "policy_not_approved" | "course_ended" | "outside_window" | "unknown_participant" | "consent_missing";
export type GateResult = { allowed: true; studentId?: string } | { allowed: false; reason: GateBlock };

/** SQL: the consent_history row behind the student's current consent state (the triggers write one row per change). */
export const currentHistorySql = (team: string, student: string) =>
  `(SELECT MAX(h.id) FROM consent_history h WHERE h.team_id = ${team} AND h.student_id = ${student})`;
/**
 * SQL predicate: the student has a valid consent right now. Granted, on the course's current form version,
 * and re-confirmed by the student (QR) on a link issued for exactly this grant. Links from before a withdrawal
 * or re-grant point at an older history row and no longer count, even when the timestamps are equal.
 */
export const validConsentSql = (team: string, student: string) => `EXISTS (
  SELECT 1 FROM consents cs JOIN teams vt ON vt.id = cs.team_id JOIN courses vc ON vc.id = vt.course_id
  WHERE cs.team_id = ${team} AND cs.student_id = ${student} AND cs.status = 'granted' AND cs.version = vc.consent_version
    AND EXISTS (SELECT 1 FROM consent_confirmations k WHERE k.team_id = cs.team_id AND k.student_id = cs.student_id
      AND k.version = cs.version AND k.confirmed_at IS NOT NULL
      AND k.consent_history_id = ${currentHistorySql("cs.team_id", "cs.student_id")}))`;
/** SQL predicate: the course's form version is operator-approved and the course has not ended. */
export const pilotReadySql = (course: string, now: string) => `EXISTS (
  SELECT 1 FROM courses pc JOIN consent_policies pp ON pp.version = pc.consent_version
  WHERE pc.id = ${course} AND pc.ends_at IS NOT NULL AND pc.ends_at > ${now})`;

type TeamGateRow = { collection_status: string; approved: number; ends_at: number | null; in_window: number };

/** May data from `slackUserId` (or the team as a whole) at time `at` be collected now? */
export async function collectionGate(
  db: D1Database, input: { teamId: string; at: number; now: number; slackUserId?: string },
): Promise<GateResult> {
  const team = await db.prepare(`SELECT t.collection_status, c.ends_at,
      EXISTS (SELECT 1 FROM consent_policies p WHERE p.version = c.consent_version) AS approved,
      EXISTS (SELECT 1 FROM collection_windows w WHERE w.team_id = t.id AND w.started_at <= ? AND (w.ended_at IS NULL OR w.ended_at > ?)) AS in_window
    FROM teams t JOIN courses c ON c.id = t.course_id WHERE t.id = ?`).bind(input.at, input.at, input.teamId).first<TeamGateRow>();
  if (!team || team.collection_status !== "active") return { allowed: false, reason: "team_inactive" };
  if (!team.approved) return { allowed: false, reason: "policy_not_approved" };
  if (team.ends_at === null || team.ends_at <= input.now) return { allowed: false, reason: "course_ended" };
  if (!team.in_window) return { allowed: false, reason: "outside_window" };
  if (input.slackUserId === undefined) return { allowed: true };
  const member = await db.prepare(`SELECT m.student_id, ${validConsentSql("m.team_id", "m.student_id")} AS consented
    FROM team_members m JOIN student_slack_mappings s ON s.student_id = m.student_id
    WHERE m.team_id = ? AND s.slack_user_id = ?`).bind(input.teamId, input.slackUserId).first<{ student_id: string; consented: number }>();
  if (!member) return { allowed: false, reason: "unknown_participant" };
  if (!member.consented) return { allowed: false, reason: "consent_missing" };
  return { allowed: true, studentId: member.student_id };
}

/**
 * A statement to put first in a write batch. It aborts the whole batch unless, at that moment, the team still collects
 * (active, approved form, course not ended) and every given author still has a valid consent, which closes the gap
 * between a gate check and its writes. SQLite has no RAISE outside triggers, so json() on a non-JSON string aborts.
 */
export function stillCollectable(db: D1Database, teamId: string, authors: Iterable<string>, now: number): D1PreparedStatement {
  const list = [...new Set(authors)];
  return db.prepare(`SELECT json(CASE WHEN
      EXISTS (SELECT 1 FROM teams gt WHERE gt.id = ? AND gt.collection_status = 'active' AND ${pilotReadySql("gt.course_id", "?")})
      AND (SELECT COUNT(DISTINCT gs.slack_user_id) FROM team_members gm JOIN student_slack_mappings gs ON gs.student_id = gm.student_id
        WHERE gm.team_id = ? AND gs.slack_user_id IN (${list.map(() => "?").join(", ")}) AND ${validConsentSql("gm.team_id", "gm.student_id")}) = ?
    THEN '1' ELSE 'collection_gate_closed' END)`).bind(teamId, now, teamId, ...list, list.length);
}

/** Statements that stop collection for a team and close its open window. Safe to repeat; batch them with the cause. */
export function pauseTeam(db: D1Database, teamId: string, reason: EndReason, at: number): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE collection_windows SET ended_at = MAX(?, started_at), end_reason = ? WHERE team_id = ? AND ended_at IS NULL")
      .bind(at, reason, teamId),
    db.prepare("UPDATE teams SET collection_status = 'paused' WHERE id = ? AND collection_status = 'active'").bind(teamId),
  ];
}

export * from "./events";
export * from "./slack";
export * from "./history";
