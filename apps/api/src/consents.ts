import { Hono, type Context } from "hono";
import {
  activateTeamSchema, consentConfirmationLookupSchema, consentConfirmSchema, courseParamsSchema, coursePilotSchema,
  deactivateTeamSchema, setConsentSchema, teamParamsSchema, teamStudentParamsSchema,
  type ActivateTeamResponse, type CollectionStatusResponse, type Consent, type ConsentConfirmationLookupResponse, type CoursePilotResponse,
} from "@teamplanet/contracts";
import { pauseTeam, pilotReadySql, validConsentSql, type EndReason } from "@teamplanet/collection";
import { iso, randomToken, sha256 } from "./auth";
import { apiError, parseBody } from "./errors";
import { audit, owned } from "./guard";
import type { SlackEnv, SlackFetch } from "./slack";
import { liveMembership } from "./teams";

// ponytail: 7 days lets a professor hand out QR codes in class; make it a course setting if pilots ask for another length.
const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60_000;

type TeamRow = { id: string; course_id: string; workspace_id: string; channel_id: string; collection_status: string };
type ConsentRow = { team_id: string; student_id: string; status: Consent["status"]; version: string; recorded_at: number; confirmed_at: number | null };
const CONSENT_SQL = `SELECT cs.team_id, cs.student_id, cs.status, cs.version, cs.recorded_at,
    (SELECT MAX(k.confirmed_at) FROM consent_confirmations k WHERE k.team_id = cs.team_id AND k.student_id = cs.student_id
      AND k.version = cs.version AND k.confirmed_at IS NOT NULL AND k.created_at >= cs.recorded_at) AS confirmed_at
  FROM consents cs`;
const toConsent = (row: ConsentRow): Consent => ({
  teamId: row.team_id, studentId: row.student_id, status: row.status, version: row.version,
  recordedAt: iso(row.recorded_at), studentConfirmedAt: row.confirmed_at === null ? null : iso(row.confirmed_at),
});

const invalidRequest = (context: Context) => apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
const notFound = (context: Context) => apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
const policyNotApproved = (context: Context, message = "승인된 동의서 버전과 수업 종료일을 먼저 설정하세요.") =>
  apiError(context, "POLICY_NOT_APPROVED", message);

export function consentRoutes(now: () => number, send: SlackFetch) {
  const routes = new Hono<SlackEnv>();
  const teamParam = (context: Context<SlackEnv>) => teamParamsSchema.safeParse({ teamId: context.req.param("teamId") });

  async function pilot(context: Context<SlackEnv>, courseId: string): Promise<CoursePilotResponse> {
    const row = (await context.env.DB.prepare(`SELECT consent_version, ends_at,
        EXISTS (SELECT 1 FROM consent_policies p WHERE p.version = courses.consent_version) AS approved FROM courses WHERE id = ?`)
      .bind(courseId).first<{ consent_version: string | null; ends_at: number | null; approved: number }>())!;
    return {
      courseId, consentVersion: row.consent_version, endsAt: row.ends_at === null ? null : iso(row.ends_at), policyApproved: row.approved === 1,
    };
  }

  routes.get("/courses/:courseId/pilot", async context => {
    const path = courseParamsSchema.safeParse({ courseId: context.req.param("courseId") });
    if (!path.success) return invalidRequest(context);
    if (!await owned(context, "course", path.data.courseId)) return notFound(context);
    return context.json(await pilot(context, path.data.courseId), 200);
  });

  // The professor picks an operator-approved form version and the real course end. Changing the version stops active teams.
  routes.put("/courses/:courseId/pilot", async context => {
    const path = courseParamsSchema.safeParse({ courseId: context.req.param("courseId") });
    if (!path.success) return invalidRequest(context);
    const input = await parseBody(context, coursePilotSchema);
    if (input.error) return input.error;
    const { courseId } = path.data;
    const course = await owned<{ consent_version: string | null }>(context, "course", courseId);
    if (!course) return notFound(context);
    const db = context.env.DB;
    const at = now();
    if (!await db.prepare("SELECT 1 FROM consent_policies WHERE version = ?").bind(input.data.consentVersion).first()) {
      return policyNotApproved(context, "운영자가 승인한 동의서 버전이 아닙니다.");
    }
    const endsAt = Date.parse(input.data.endsAt);
    if (endsAt <= at) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.", { issues: [{ path: ["endsAt"], message: "수업 종료일은 미래여야 합니다." }] });
    const writes = [db.prepare("UPDATE courses SET consent_version = ?, ends_at = ? WHERE id = ?").bind(input.data.consentVersion, endsAt, courseId)];
    if (course.consent_version !== null && course.consent_version !== input.data.consentVersion) {
      const { results } = await db.prepare("SELECT id FROM teams WHERE course_id = ? AND collection_status = 'active'").bind(courseId).all<{ id: string }>();
      for (const team of results) writes.push(...pauseTeam(db, team.id, "policy_changed", at));
    }
    writes.push(audit(context, { action: "course.pilot_set", targetType: "course", targetId: courseId, result: "succeeded" }, now));
    await db.batch(writes);
    return context.json(await pilot(context, courseId), 200);
  });

  routes.get("/teams/:teamId/consents", async context => {
    const parsed = teamParam(context);
    if (!parsed.success) return invalidRequest(context);
    if (!await owned(context, "team", parsed.data.teamId)) return notFound(context);
    const { results } = await context.env.DB.prepare(`${CONSENT_SQL} WHERE cs.team_id = ? ORDER BY cs.student_id`).bind(parsed.data.teamId).all<ConsentRow>();
    return context.json({ consents: results.map(toConsent) }, 200);
  });

  // The professor records the offline paper consent. History rows come from the existing consent_history triggers.
  routes.put("/teams/:teamId/consents/:studentId", async context => {
    const path = teamStudentParamsSchema.safeParse({ teamId: context.req.param("teamId"), studentId: context.req.param("studentId") });
    if (!path.success) return invalidRequest(context);
    const input = await parseBody(context, setConsentSchema);
    if (input.error) return input.error;
    const { teamId, studentId } = path.data;
    const { status, version, evidenceRef } = input.data;
    const db = context.env.DB;
    const team = await owned<TeamRow>(context, "team", teamId);
    const member = team && await db.prepare("SELECT 1 FROM team_members WHERE team_id = ? AND student_id = ?").bind(teamId, studentId).first();
    if (!team || !member) {
      await audit(context, { action: "consent.set", targetType: "student", targetId: studentId, result: "denied" }, now).run();
      return notFound(context);
    }
    const settings = await pilot(context, team.course_id);
    if (!settings.policyApproved) return policyNotApproved(context);
    if (version !== settings.consentVersion) return policyNotApproved(context, "수업에 설정된 동의서 버전과 다릅니다.");
    if (status === "granted" && !evidenceRef) {
      return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.", { issues: [{ path: ["evidenceRef"], message: "동의서 증빙 참조가 필요합니다." }] });
    }
    const read = () => db.prepare(`${CONSENT_SQL} WHERE cs.team_id = ? AND cs.student_id = ?`).bind(teamId, studentId).first<ConsentRow>();
    const current = await read();
    // Repeating the same state changes nothing, so it cannot silently void an existing student confirmation.
    if (current && current.status === status && current.version === version) return context.json(toConsent(current), 200);

    const at = now();
    const writes = [
      db.prepare(`INSERT INTO consents (team_id, student_id, status, version, recorded_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (team_id, student_id) DO UPDATE SET status = excluded.status, version = excluded.version, recorded_at = excluded.recorded_at`)
        .bind(teamId, studentId, status, version, at),
      db.prepare(`INSERT INTO consent_evidence (history_id, actor_professor_id, evidence_ref)
        SELECT MAX(id), ?, ? FROM consent_history WHERE team_id = ? AND student_id = ?`)
        .bind(context.get("professor").id, evidenceRef ?? null, teamId, studentId),
      audit(context, { action: "consent.set", targetType: "student", targetId: studentId, result: "succeeded" }, now),
    ];
    // Any change away from a valid grant stops collection at once; re-activation re-checks everyone.
    if (status !== "granted") writes.push(...pauseTeam(db, teamId, "consent_changed", at));
    await db.batch(writes);
    return context.json(toConsent((await read())!), 200);
  });

  // One personal link per student and grant. Issuing a new link drops older unused ones.
  routes.post("/teams/:teamId/consents/:studentId/confirmation", async context => {
    const path = teamStudentParamsSchema.safeParse({ teamId: context.req.param("teamId"), studentId: context.req.param("studentId") });
    if (!path.success) return invalidRequest(context);
    const { teamId, studentId } = path.data;
    const db = context.env.DB;
    if (!await owned(context, "team", teamId)) return notFound(context);
    const consent = await db.prepare(`SELECT cs.version FROM consents cs JOIN teams t ON t.id = cs.team_id JOIN courses c ON c.id = t.course_id
      WHERE cs.team_id = ? AND cs.student_id = ? AND cs.status = 'granted' AND cs.version = c.consent_version`).bind(teamId, studentId).first<{ version: string }>();
    if (!consent) return apiError(context, "CONSENT_REQUIRED", "먼저 오프라인 동의서 확보를 기록하세요.");
    const token = randomToken();
    const at = now();
    const expiresAt = at + CONFIRMATION_TTL_MS;
    await db.batch([
      db.prepare("DELETE FROM consent_confirmations WHERE team_id = ? AND student_id = ? AND confirmed_at IS NULL").bind(teamId, studentId),
      db.prepare(`INSERT INTO consent_confirmations (token_hash, team_id, student_id, version, issued_by_professor_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(await sha256(token), teamId, studentId, consent.version, context.get("professor").id, at, expiresAt),
      audit(context, { action: "consent.link_issue", targetType: "student", targetId: studentId, result: "succeeded" }, now),
    ]);
    // The fragment never reaches servers or Referer headers; the student page (#29) posts it back in the body.
    const confirmationUrl = new URL(`/consent/confirm#${token}`, context.req.url).toString();
    return context.json({ confirmationUrl, expiresAt: iso(expiresAt) }, 201);
  });

  // Student side, no professor session (guard.ts exempts /v1/consent-confirmations/). The personal token is the only key.
  const confirmationRow = async (context: Context<SlackEnv>, token: string) => context.env.DB.prepare(`SELECT k.*, c.name AS course_name,
      t.name AS team_name, s.display_name FROM consent_confirmations k JOIN teams t ON t.id = k.team_id JOIN courses c ON c.id = t.course_id
      JOIN students s ON s.id = k.student_id WHERE k.token_hash = ?`).bind(await sha256(token))
    .first<{ version: string; expires_at: number; confirmed_at: number | null; course_name: string; team_name: string; display_name: string }>();

  routes.post("/consent-confirmations/lookup", async context => {
    const input = await parseBody(context, consentConfirmationLookupSchema);
    if (input.error) return input.error;
    const row = await confirmationRow(context, input.data.token);
    if (!row || (row.confirmed_at === null && row.expires_at <= now())) return notFound(context);
    return context.json({
      courseName: row.course_name, teamName: row.team_name, studentDisplayName: row.display_name, version: row.version,
      expiresAt: iso(row.expires_at), confirmedAt: row.confirmed_at === null ? null : iso(row.confirmed_at),
    } satisfies ConsentConfirmationLookupResponse, 200);
  });

  routes.post("/consent-confirmations/confirm", async context => {
    const input = await parseBody(context, consentConfirmSchema);
    if (input.error) return input.error;
    const db = context.env.DB;
    const at = now();
    const hash = await sha256(input.data.token);
    // Single use, unexpired, and only while the grant it was issued for is still the current state.
    const confirmed = await db.prepare(`UPDATE consent_confirmations SET confirmed_at = ?
      WHERE token_hash = ? AND confirmed_at IS NULL AND expires_at > ? AND EXISTS (
        SELECT 1 FROM consents cs WHERE cs.team_id = consent_confirmations.team_id AND cs.student_id = consent_confirmations.student_id
          AND cs.status = 'granted' AND cs.version = consent_confirmations.version AND cs.recorded_at <= consent_confirmations.created_at)
      RETURNING confirmed_at`).bind(at, hash, at).first<{ confirmed_at: number }>();
    if (confirmed) return context.json({ confirmedAt: iso(confirmed.confirmed_at) }, 200);
    const previous = await confirmationRow(context, input.data.token);
    if (previous?.confirmed_at) return context.json({ confirmedAt: iso(previous.confirmed_at) }, 200);
    return notFound(context);
  });

  routes.post("/teams/:teamId/activate", async context => {
    const parsed = teamParam(context);
    if (!parsed.success) return invalidRequest(context);
    // `{}` only: flags such as consentApproved:true are rejected by the strict schema.
    const input = await parseBody(context, activateTeamSchema);
    if (input.error) return input.error;
    const { teamId } = parsed.data;
    const db = context.env.DB;
    const team = await owned<TeamRow>(context, "team", teamId);
    if (!team) return notFound(context);
    const openWindow = () => db.prepare("SELECT started_at FROM collection_windows WHERE team_id = ? AND ended_at IS NULL").bind(teamId).first<{ started_at: number }>();
    const answer = (window: { started_at: number }) =>
      context.json({ teamId, collectionStatus: "active", activatedAt: iso(window.started_at) } satisfies ActivateTeamResponse, 200);
    const denied = async (response: Response) => {
      await audit(context, { action: "team.activate", targetType: "team", targetId: teamId, result: "denied" }, now).run();
      return response;
    };
    const existing = team.collection_status === "active" ? await openWindow() : null;
    if (existing) return answer(existing);

    const ready = await db.prepare(`SELECT ${pilotReadySql("?", "?")} AS ready`).bind(team.course_id, now()).first<{ ready: number }>();
    if (!ready?.ready) return denied(policyNotApproved(context));
    const membership = await liveMembership(context, team, send, now);
    if (membership instanceof Response) return membership;
    if (!membership.complete) return denied(apiError(context, "CHANNEL_MEMBERSHIP_REQUIRED", "봇·학생 채널 멤버십과 매핑을 먼저 완료하세요."));
    const missing = await db.prepare(`SELECT 1 FROM team_members m WHERE m.team_id = ? AND NOT ${validConsentSql("m.team_id", "m.student_id")}`).bind(teamId).first();
    if (missing) return denied(apiError(context, "CONSENT_REQUIRED", "모든 참가자의 동의서 확보와 학생 재확인이 필요합니다."));

    // The same checks again inside the write, so a withdrawal racing this request cannot be activated over.
    const at = now();
    await db.batch([
      db.prepare(`UPDATE teams SET collection_status = 'active' WHERE id = ? AND collection_status <> 'active'
        AND ${pilotReadySql("teams.course_id", "?")}
        AND EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = teams.id)
        AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = teams.id AND NOT ${validConsentSql("m.team_id", "m.student_id")})`)
        .bind(teamId, at),
      db.prepare(`INSERT INTO collection_windows (team_id, started_at) SELECT ?, ?
        WHERE EXISTS (SELECT 1 FROM teams WHERE id = ? AND collection_status = 'active')
        AND NOT EXISTS (SELECT 1 FROM collection_windows WHERE team_id = ? AND ended_at IS NULL)`).bind(teamId, at, teamId, teamId),
    ]);
    const window = await openWindow();
    if (!window) return denied(apiError(context, "CONSENT_REQUIRED", "모든 참가자의 동의서 확보와 학생 재확인이 필요합니다."));
    await audit(context, { action: "team.activate", targetType: "team", targetId: teamId, result: "succeeded" }, now).run();
    return answer(window);
  });

  routes.post("/teams/:teamId/deactivate", async context => {
    const parsed = teamParam(context);
    if (!parsed.success) return invalidRequest(context);
    const input = await parseBody(context, deactivateTeamSchema);
    if (input.error) return input.error;
    const { teamId } = parsed.data;
    if (!await owned(context, "team", teamId)) return notFound(context);
    const reason: EndReason = "professor";
    await context.env.DB.batch([
      ...pauseTeam(context.env.DB, teamId, reason, now()),
      audit(context, { action: "team.deactivate", targetType: "team", targetId: teamId, result: "succeeded" }, now),
    ]);
    return context.json(await collectionStatus(context, teamId), 200);
  });

  async function collectionStatus(context: Context<SlackEnv>, teamId: string): Promise<CollectionStatusResponse> {
    const db = context.env.DB;
    const team = (await db.prepare("SELECT collection_status FROM teams WHERE id = ?").bind(teamId).first<{ collection_status: CollectionStatusResponse["collectionStatus"] }>())!;
    const { results } = await db.prepare("SELECT started_at, ended_at, end_reason FROM collection_windows WHERE team_id = ? ORDER BY started_at, id")
      .bind(teamId).all<{ started_at: number; ended_at: number | null; end_reason: CollectionStatusResponse["windows"][number]["endReason"] }>();
    return {
      teamId, collectionStatus: team.collection_status,
      windows: results.map(w => ({ startedAt: iso(w.started_at), endedAt: w.ended_at === null ? null : iso(w.ended_at), endReason: w.end_reason })),
    };
  }

  routes.get("/teams/:teamId/collection", async context => {
    const parsed = teamParam(context);
    if (!parsed.success) return invalidRequest(context);
    if (!await owned(context, "team", parsed.data.teamId)) return notFound(context);
    return context.json(await collectionStatus(context, parsed.data.teamId), 200);
  });

  return routes;
}
