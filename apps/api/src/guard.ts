import type { Context, MiddlewareHandler } from "hono";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Professor } from "@teamplanet/contracts";
import { sessionProfessor, sessionToken } from "./auth";
import { apiError } from "./errors";

export type ProtectedEnv = { Bindings: { DB: D1Database }; Variables: { professor: Professor } };

// Paths that authenticate themselves. Slack OAuth callback/events (#6/#11) join here with their own signature/state checks.
const selfAuthenticated = (path: string) => path === "/v1/health" || path.startsWith("/v1/auth/");

/** Default deny: every other /v1 route needs a live professor session before any handler runs. */
export function requireSession(now: () => number): MiddlewareHandler<ProtectedEnv> {
  return async (context, next) => {
    if (selfAuthenticated(context.req.path)) return next();
    const session = await sessionProfessor(context.env.DB, sessionToken(context), now());
    if (!session) return apiError(context, "UNAUTHENTICATED", "로그인이 필요합니다.");
    context.set("professor", session.professor);
    await next();
  };
}

// The professor always comes from the session join, never from request input.
const ownershipSql = {
  course: "SELECT c.* FROM courses c WHERE c.id = ? AND c.professor_id = ?",
  team: "SELECT t.* FROM teams t JOIN courses c ON c.id = t.course_id WHERE t.id = ? AND c.professor_id = ?",
  student: "SELECT s.* FROM students s JOIN courses c ON c.id = s.course_id WHERE s.id = ? AND c.professor_id = ?",
  run: `SELECT r.* FROM analysis_runs r JOIN teams t ON t.id = r.team_id JOIN courses c ON c.id = t.course_id
    WHERE r.id = ? AND c.professor_id = ?`,
  evidence: `SELECT e.* FROM evidence_events e JOIN analysis_runs r ON r.id = e.run_id JOIN teams t ON t.id = r.team_id
    JOIN courses c ON c.id = t.course_id WHERE e.id = ? AND c.professor_id = ?`,
} as const;
export type OwnedKind = keyof typeof ownershipSql;

/** Row of `kind` owned by the session professor, or null for both "missing" and "someone else's" (same 404). */
export function owned<T = Record<string, unknown>>(context: Context<ProtectedEnv>, kind: OwnedKind, id: string) {
  return context.env.DB.prepare(ownershipSql[kind]).bind(id, context.get("professor").id).first<T>();
}

export type AuditAction = "course.create" | "team.read";
export type AuditEvent = { action: AuditAction; targetType: OwnedKind; targetId: string; result: "succeeded" | "denied" };

/** Returns the INSERT so callers can `.run()` it or batch it atomically with the audited write. */
export function audit(context: Context<ProtectedEnv>, event: AuditEvent, now: () => number): D1PreparedStatement {
  return context.env.DB.prepare(`INSERT INTO audit_events (actor_professor_id, action, target_type, target_id, result, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(context.get("professor").id, event.action, event.targetType, event.targetId, event.result, now());
}
