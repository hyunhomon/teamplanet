import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { inquiryRoutes } from "../apps/api/src/inquiries";
import { createApp } from "../apps/api/src/index";
import { defaultAuthDeps, sha256 } from "../apps/api/src/auth";
import type { ProtectedEnv } from "../apps/api/src/guard";
import { collectionFixture } from "./helpers/collection";
import { sweepInquiries } from "@teamplanet/collection";
import { inquirySchema, inquirySettingsInputSchema, inquiryStudentViewSchema } from "@teamplanet/contracts";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { inquiryRequest } from "../apps/web/src/lib/inquiries";

let f: Awaited<ReturnType<typeof collectionFixture>>, clock: number, app: Hono<ProtectedEnv>, professor: (typeof fixtures.professors)[number];
const token = "a".repeat(43), otherToken = "b".repeat(43), DAY = 86400000;
beforeEach(async () => {
  f = await collectionFixture(); clock = f.now(); professor = f.professor;
  f.sqlite.run("UPDATE consent_confirmations SET token_hash = ?", [await sha256(token)]);
  app = new Hono<ProtectedEnv>(); app.use("*", async (c, next) => { c.set("professor", professor); await next(); }); app.route("/", inquiryRoutes(() => clock));
});
afterEach(() => f.sqlite.close());
const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => app.request(`https://synthetic${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: f.db });
const setting = (days: unknown) => call(`/courses/${f.course.id}/inquiry-settings`, { days }, "PUT");
const lookup = async (value = token) => inquiryStudentViewSchema.parse(await (await call("/student-inquiries/lookup", { token: value })).json());
async function submit(ticket?: string | null) {
  const selected = ticket ?? (await lookup()).ticket;
  return call("/student-inquiries", { token, ticket: selected, body: "합성 정정 요청입니다." });
}
test("no default n; rejects invalid n, other professor/course, forged identity and student ID substitution", async () => {
  expect((await lookup()).days).toBeNull(); expect((await lookup()).ticket).toBeNull();
  for (const days of [0, -1, 1.5, "3", 3_000_000, Number.MAX_SAFE_INTEGER]) expect((await setting(days)).status).toBe(400);
  expect(inquirySettingsInputSchema.safeParse({ days: 1 }).success).toBe(true);
  professor = fixtures.professors[1]!;
  expect((await setting(3)).status).toBe(404);
  expect((await call(`/courses/${f.course.id}/inquiries`)).status).toBe(404);
  expect((await call("/student-inquiries/lookup", { token: otherToken })).status).toBe(404);
  expect((await call("/student-inquiries/lookup", { token, studentId: fixtures.students[1]!.id })).status).toBe(400);
});
test("reception+n is fixed across settings and answers; duplicate/concurrent submission is one receipt", async () => {
  await setting(2); const view = await lookup();
  expect(view.professorEmail).toBe(f.professor.email); expect(Date.parse(view.proposedExpiresAt!)).toBe(clock + 2 * DAY);
  const responses = await Promise.all([submit(view.ticket), submit(view.ticket)]);
  const [first, repeated] = await Promise.all(responses.map(async r => inquirySchema.parse(await r.json())));
  expect(first).toEqual(repeated); expect(f.sqlite.query("SELECT id FROM inquiries").all()).toHaveLength(1);
  expect(() => f.sqlite.run("UPDATE inquiries SET days = 10")).toThrow("inquiry_receipt_immutable");
  await setting(4); clock += DAY;
  const answered = inquirySchema.parse(await (await call(`/inquiries/${first!.id}/answer`, { answer: "합성 답변입니다." }, "PUT")).json());
  expect(answered.receivedAt).toBe(first!.receivedAt); expect(answered.expiresAt).toBe(first!.expiresAt); expect(answered.days).toBe(2);
  expect((await lookup()).days).toBe(4);
  expect((await call(`/student-inquiries/${first!.id}`, { token: otherToken })).status).toBe(404);
  professor = fixtures.professors[1]!;
  expect((await call(`/inquiries/${first!.id}/answer`, { answer: "forged" }, "PUT")).status).toBe(404);
});
test("changed settings invalidate unsubmitted tickets; expired/consumed tickets never recreate deleted requests", async () => {
  await setting(1); const stale = await lookup(); await setting(2);
  expect((await submit(stale.ticket)).status).toBe(409);
  const fresh = await lookup(); const row = inquirySchema.parse(await (await submit(fresh.ticket)).json());
  clock = Date.parse(row.expiresAt);
  expect((await call(`/student-inquiries/${row.id}`, { token })).status).toBe(404);
  expect((await call(`/inquiries/${row.id}/answer`, { answer: "late" }, "PUT")).status).toBe(404);
  expect((await lookup()).inquiries).toEqual([]);
  await sweepInquiries(f.db, clock); await sweepInquiries(f.db, clock);
  expect(f.sqlite.query("SELECT * FROM inquiries").all()).toEqual([]);
  expect((await submit(fresh.ticket)).status).toBe(409);
});
test("answered and unanswered expire together; cleanup rollback and retry report failure without changing consent history", async () => {
  await setting(1); const a = inquirySchema.parse(await (await submit()).json()); await submit();
  await call(`/inquiries/${a.id}/answer`, { answer: "synthetic" }, "PUT");
  const before = f.sqlite.query("SELECT * FROM consent_history").all();
  f.sqlite.run("CREATE TRIGGER synthetic_cleanup_failure BEFORE DELETE ON inquiries BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  clock = Date.parse(a.expiresAt);
  await expect(sweepInquiries(f.db, clock)).rejects.toThrow("INQUIRY_CLEANUP_FAILED");
  expect((await (await call(`/courses/${f.course.id}/inquiry-settings`)).json() as any).cleanupError).toBe("INQUIRY_CLEANUP_FAILED");
  expect((await (await call(`/courses/${f.course.id}/inquiries`)).json() as any).inquiries).toEqual([]);
  f.sqlite.run("DROP TRIGGER synthetic_cleanup_failure"); await sweepInquiries(f.db, clock);
  expect(f.sqlite.query("SELECT * FROM inquiries").all()).toEqual([]);
  expect(f.sqlite.query("SELECT * FROM consent_history").all()).toEqual(before);
  expect((await (await call(`/courses/${f.course.id}/inquiry-settings`)).json() as any).cleanupError).toBeNull();
});
test("actual withdrawal is separate and body-free; expiry cannot undo it", async () => {
  await setting(1); const row = inquirySchema.parse(await (await submit()).json());
  expect((await call(`/inquiries/${row.id}/action`, { kind: "withdrawal" })).status).toBe(200);
  expect((await call(`/inquiries/${row.id}/action`, { kind: "withdrawal" })).status).toBe(200);
  expect((f.sqlite.query("SELECT status FROM consents").get() as any).status).toBe("withdrawn");
  expect((await lookup()).inquiries).toHaveLength(1); // Inquiry identity does not regrant collection rights.
  expect(JSON.stringify(f.sqlite.query("SELECT * FROM inquiry_effects").all())).not.toContain(row.body);
  clock = Date.parse(row.expiresAt); await sweepInquiries(f.db, clock);
  expect(f.sqlite.query("SELECT * FROM inquiries").all()).toEqual([]);
  expect((f.sqlite.query("SELECT status FROM consents").get() as any).status).toBe("withdrawn");
  expect(f.sqlite.query("SELECT * FROM consent_history").all()).toHaveLength(2);
});
test("answer racing expiry cannot update or resurrect a removed row; stored evaluations survive cleanup", async () => {
  await setting(1); const row = inquirySchema.parse(await (await submit()).json());
  f.sqlite.run("INSERT INTO analysis_runs VALUES ('legacy_evaluation', ?, 'a', 'b', 'finalized', NULL, ?)", [f.teamId, f.professor.id]);
  const before = f.sqlite.query("SELECT * FROM analysis_runs").all();
  const original = f.db.prepare.bind(f.db);
  const db = { ...f.db, prepare(sql: string) {
    const stmt = original(sql);
    if (!sql.startsWith("UPDATE inquiries SET answer")) return stmt;
    return { ...stmt, bind(...values: any[]) {
      const bound = stmt.bind(...values);
      return { ...bound, async first() { await sweepInquiries(f.db, Date.parse(row.expiresAt)); return bound.first(); } };
    } };
  } } as any;
  const response = await app.request(`https://synthetic/inquiries/${row.id}/answer`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "late" }) }, { DB: db });
  expect(response.status).toBe(404);
  expect(f.sqlite.query("SELECT * FROM inquiries").all()).toEqual([]);
  expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toEqual(before);
});
test("cleanup and professor lists keep another course isolated", async () => {
  await setting(1); await submit();
  const p = fixtures.professors[1]!, c = fixtures.courses[1]!, t = fixtures.teams[1]!, s = fixtures.students[1]!;
  f.sqlite.run("INSERT INTO professors VALUES (?, ?, 0)", [p.id, p.email]);
  f.sqlite.run("INSERT INTO courses (id, professor_id, name, created_at) VALUES (?, ?, 'other synthetic', 0)", [c.id, p.id]);
  f.sqlite.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name) VALUES (?, ?, ?, 'COTHER123', 'other')", [t.id, c.id, f.workspace.id]);
  f.sqlite.run("INSERT INTO students VALUES (?, ?, 'other', 0)", [s.id, c.id]);
  f.sqlite.run("INSERT INTO inquiries VALUES ('inquiry_other', ?, ?, ?, 'other-hash', 'other synthetic body', NULL, ?, 3, ?, NULL)", [c.id, t.id, s.id, clock, clock + 3 * DAY]);
  const before = f.sqlite.query("SELECT * FROM inquiries WHERE course_id = ?").all(c.id);
  expect((await (await call(`/courses/${f.course.id}/inquiries`)).json() as any).inquiries).toHaveLength(1);
  await sweepInquiries(f.db, clock + DAY);
  expect(f.sqlite.query("SELECT * FROM inquiries WHERE course_id = ?").all(c.id)).toEqual(before);
  expect(f.sqlite.query("SELECT * FROM inquiries WHERE course_id = ?").all(f.course.id)).toEqual([]);
});
test("student route works without professor session while management remains protected; UI client sends scoped credentials", async () => {
  const full = createApp({ ...defaultAuthDeps, now: () => clock });
  expect((await full.request("https://synthetic/v1/student-inquiries/lookup", { method: "POST", headers: { Origin: "https://synthetic", "Content-Type": "application/json" }, body: JSON.stringify({ token }) }, { DB: f.db } as any)).status).toBe(200);
  expect((await full.request(`https://synthetic/v1/courses/${f.course.id}/inquiries`, {}, { DB: f.db } as any)).status).toBe(401);
  let init: RequestInit | undefined;
  const fetcher = (async (_url: unknown, value: RequestInit) => { init = value; return Response.json(await lookup()); }) as typeof fetch;
  await inquiryRequest("/student-inquiries/lookup", inquiryStudentViewSchema, { token }, false, "POST", fetcher);
  expect(init?.credentials).toBe("omit"); expect(init?.cache).toBe("no-store");
});
