import { Hono, type Context } from "hono";
import { courseParamsSchema, inquiryActionSchema, inquiryAnswerSchema, inquiryIdentitySchema, inquirySettingsInputSchema, inquirySubmitSchema } from "@teamplanet/contracts";
import { invalidateTeam, pauseTeam, retentionDeadlineSql } from "@teamplanet/collection";
import { iso, randomToken, sha256 } from "./auth";
import { apiError, parseBody } from "./errors";
import { owned, type ProtectedEnv } from "./guard";

type Row = { id: string; course_id: string; team_id: string; student_id: string; body: string; answer: string | null; received_at: number; days: number; expires_at: number; answered_at: number | null };
const output = (r: Row) => ({ id: r.id, body: r.body, answer: r.answer, receivedAt: iso(r.received_at), days: r.days, expiresAt: iso(r.expires_at), answeredAt: r.answered_at === null ? null : iso(r.answered_at) });
const DAY = 86400000, TICKET_MS = 10 * 60000;
// Shared RFC3339 contract uses a four-digit year, independently of product retention choices.
const dateValid = (value: number) => Number.isSafeInteger(value) && value <= 253402300799999;
/** Inquiry identity is not collection consent. Confirmed students can still request withdrawal/correction. */
export function inquiryRoutes(now: () => number) {
  const routes = new Hono<ProtectedEnv>();
  const missing = (c: Context) => apiError(c, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
  routes.get("/courses/:courseId/inquiry-settings", async c => {
    const id = courseParamsSchema.safeParse({ courseId: c.req.param("courseId") });
    if (!id.success) return apiError(c, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(c, "course", id.data.courseId)) return missing(c);
    const row = await c.env.DB.prepare("SELECT * FROM inquiry_settings WHERE course_id = ?").bind(id.data.courseId).first<any>();
    return c.json({ courseId: id.data.courseId, days: row?.days ?? null, lastCleanupAt: row?.last_cleanup_at == null ? null : iso(row.last_cleanup_at), cleanupError: row?.cleanup_error ?? null });
  });
  routes.put("/courses/:courseId/inquiry-settings", async c => {
    const id = courseParamsSchema.safeParse({ courseId: c.req.param("courseId") });
    if (!id.success) return apiError(c, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(c, "course", id.data.courseId)) return missing(c);
    const input = await parseBody(c, inquirySettingsInputSchema); if (input.error) return input.error;
    if (!dateValid(now() + input.data.days * DAY)) return apiError(c, "VALIDATION_ERROR", "유효한 만료 날짜가 되는 일수를 설정하세요.");
    await c.env.DB.prepare(`INSERT INTO inquiry_settings (course_id, days, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(course_id) DO UPDATE SET days = excluded.days, updated_at = excluded.updated_at`).bind(id.data.courseId, input.data.days, now()).run();
    return c.json({ courseId: id.data.courseId, days: input.data.days });
  });
  routes.post("/student-inquiries/lookup", async c => {
    const input = await parseBody(c, inquiryIdentitySchema); if (input.error) return input.error;
    const hash = await sha256(input.data.token), at = now();
    const identity = await c.env.DB.prepare(`SELECT k.team_id, k.student_id FROM consent_confirmations k WHERE k.token_hash = ? AND k.confirmed_at IS NOT NULL
      UNION SELECT team_id, student_id FROM inquiries WHERE identity_hash = ? AND expires_at > ? LIMIT 1`).bind(hash, hash, at).first<{ team_id: string; student_id: string }>();
    if (!identity) return missing(c);
    const info = await c.env.DB.prepare(`SELECT c.id, p.email, s.days,
      (v.blocked_at IS NULL AND c.ends_at IS NOT NULL AND ${retentionDeadlineSql("c")} > ?) AS may_submit
      FROM teams t JOIN courses c ON c.id = t.course_id JOIN professors p ON p.id = c.professor_id
      JOIN team_data_versions v ON v.team_id = t.id LEFT JOIN inquiry_settings s ON s.course_id = c.id WHERE t.id = ?`)
      .bind(at, identity.team_id).first<any>();
    if (!info) return missing(c);
    let ticket: string | null = null;
    const expires = info.days ? at + info.days * DAY : null;
    if (info.days && dateValid(expires!) && info.may_submit) {
      ticket = randomToken();
      await c.env.DB.prepare(`INSERT INTO inquiry_tickets (hash, identity_hash, course_id, team_id, student_id, days, valid_until)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(await sha256(ticket), hash, info.id, identity.team_id, identity.student_id, info.days, at + TICKET_MS).run();
    }
    const rows = await c.env.DB.prepare("SELECT * FROM inquiries WHERE identity_hash = ? AND expires_at > ? ORDER BY received_at DESC").bind(hash, at).all<Row>();
    return c.json({ professorEmail: info.email, days: info.days ?? null, proposedExpiresAt: ticket ? iso(expires!) : null,
      ticket, ticketExpiresAt: ticket ? iso(at + TICKET_MS) : null, inquiries: rows.results.map(output) });
  });
  routes.post("/student-inquiries", async c => {
    const input = await parseBody(c, inquirySubmitSchema); if (input.error) return input.error;
    const hash = await sha256(input.data.token), ticket = await sha256(input.data.ticket), at = now();
    const proof = await c.env.DB.prepare(`SELECT k.* FROM inquiry_tickets k JOIN inquiry_settings s ON s.course_id = k.course_id
      WHERE k.hash = ? AND k.identity_hash = ? AND k.valid_until > ? AND (k.inquiry_id IS NOT NULL OR k.days = s.days)`)
      .bind(ticket, hash, at).first<any>();
    if (!proof || !dateValid(at + proof.days * DAY)) return apiError(c, "CONFLICT", "접수 안내가 만료되거나 변경되었습니다. 다시 조회하세요.");
    const id = `inquiry_${crypto.randomUUID()}`;
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE inquiry_tickets SET inquiry_id = ? WHERE hash = ? AND inquiry_id IS NULL AND valid_until > ?
        AND EXISTS (SELECT 1 FROM inquiry_settings s WHERE s.course_id = inquiry_tickets.course_id AND s.days = inquiry_tickets.days)
        AND EXISTS (SELECT 1 FROM team_data_versions v JOIN teams t ON t.id = v.team_id JOIN courses c ON c.id = t.course_id
          WHERE v.team_id = inquiry_tickets.team_id AND v.blocked_at IS NULL AND ${retentionDeadlineSql("c")} > ?)`)
        .bind(id, ticket, at, at),
      c.env.DB.prepare(`INSERT INTO inquiries (id, course_id, team_id, student_id, identity_hash, body, received_at, days, expires_at)
        SELECT inquiry_id, course_id, team_id, student_id, identity_hash, ?, ?, days, ? + days * 86400000 FROM inquiry_tickets
        WHERE hash = ? AND inquiry_id = ? AND valid_until > ? ON CONFLICT(id) DO NOTHING`).bind(input.data.body, at, at, ticket, id, at),
    ]);
    const row = await c.env.DB.prepare(`SELECT i.* FROM inquiries i JOIN inquiry_tickets k ON k.inquiry_id = i.id
      WHERE k.hash = ? AND i.identity_hash = ? AND i.expires_at > ?`).bind(ticket, hash, now()).first<Row>();
    if (!row) return apiError(c, "CONFLICT", "접수를 완료하지 못했습니다. 최신 안내를 다시 조회하세요.");
    return c.json(output(row), 201);
  });
  routes.post("/student-inquiries/:id", async c => {
    const input = await parseBody(c, inquiryIdentitySchema); if (input.error) return input.error;
    const row = await c.env.DB.prepare("SELECT * FROM inquiries WHERE id = ? AND identity_hash = ? AND expires_at > ?")
      .bind(c.req.param("id"), await sha256(input.data.token), now()).first<Row>();
    return row ? c.json(output(row)) : missing(c);
  });
  routes.get("/courses/:courseId/inquiries", async c => {
    const course = c.req.param("courseId"); if (!await owned(c, "course", course)) return missing(c);
    const rows = await c.env.DB.prepare("SELECT * FROM inquiries WHERE course_id = ? AND expires_at > ? ORDER BY received_at DESC").bind(course, now()).all<Row>();
    return c.json({ inquiries: rows.results.map(output) });
  });
  const ownInquiry = (c: Context<ProtectedEnv>) => c.env.DB.prepare(`SELECT i.* FROM inquiries i JOIN courses c ON c.id = i.course_id
    WHERE i.id = ? AND c.professor_id = ? AND i.expires_at > ?`).bind(c.req.param("id"), c.get("professor").id, now()).first<Row>();
  routes.put("/inquiries/:id/answer", async c => {
    const input = await parseBody(c, inquiryAnswerSchema); if (input.error) return input.error;
    if (!await ownInquiry(c)) return missing(c);
    const row = await c.env.DB.prepare(`UPDATE inquiries SET answer = ?, answered_at = ? WHERE id = ? AND expires_at > ?
      AND course_id IN (SELECT id FROM courses WHERE professor_id = ?) RETURNING *`)
      .bind(input.data.answer, now(), c.req.param("id"), now(), c.get("professor").id).first<Row>();
    return row ? c.json(output(row)) : missing(c);
  });
  routes.post("/inquiries/:id/action", async c => {
    const input = await parseBody(c, inquiryActionSchema); if (input.error) return input.error;
    const row = await ownInquiry(c); if (!row) return missing(c);
    const prior = await c.env.DB.prepare("SELECT 1 FROM inquiry_effects WHERE inquiry_id = ? AND kind = ?").bind(row.id, input.data.kind).first();
    if (prior) return c.json({ applied: true });
    const at = now(), db = c.env.DB;
    const usable = await db.prepare(`SELECT 1 FROM teams t JOIN courses c ON c.id = t.course_id JOIN team_data_versions v ON v.team_id = t.id
      WHERE t.id = ? AND v.blocked_at IS NULL AND ${retentionDeadlineSql("c")} > ?`).bind(row.team_id, at).first();
    if (!usable) return apiError(c, "CONFLICT", "정리된 수업의 처리 상태는 담당 교수에게 확인하세요.");
    const writes = [db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM inquiries i JOIN courses c ON c.id = i.course_id
      JOIN team_data_versions v ON v.team_id = i.team_id WHERE i.id = ? AND i.expires_at > ? AND v.blocked_at IS NULL AND ${retentionDeadlineSql("c")} > ?)
      THEN '1' ELSE 'inquiry_expired' END)`).bind(row.id, at, at),
      db.prepare("INSERT INTO inquiry_effects VALUES (?, ?, ?, ?, ?)").bind(row.id, row.team_id, row.student_id, input.data.kind, at)];
    if (input.data.kind === "withdrawal") {
      writes.push(db.prepare(`INSERT INTO consents (team_id, student_id, status, version, recorded_at)
        SELECT ?, ?, 'withdrawn', c.consent_version, ? FROM courses c WHERE c.id = ? AND c.consent_version IS NOT NULL
        ON CONFLICT(team_id, student_id) DO UPDATE SET status = 'withdrawn', recorded_at = excluded.recorded_at WHERE consents.status <> 'withdrawn'`)
        .bind(row.team_id, row.student_id, at, row.course_id),
        ...pauseTeam(db, row.team_id, "consent_changed", at));
    } else writes.push(invalidateTeam(db, row.team_id, "inquiry_correction", at));
    writes.push(db.prepare("INSERT INTO audit_events (actor_professor_id, action, target_type, target_id, result, recorded_at) VALUES (?, ?, 'student', ?, 'succeeded', ?)")
      .bind(c.get("professor").id, `inquiry.${input.data.kind}`, row.student_id, at));
    try { await db.batch(writes); } catch {
      if (!await db.prepare("SELECT 1 FROM inquiry_effects WHERE inquiry_id = ? AND kind = ?").bind(row.id, input.data.kind).first()) return apiError(c, "CONFLICT", "처리 상태가 변경되었습니다. 다시 조회하세요.");
    }
    return c.json({ applied: true });
  });
  return routes;
}
