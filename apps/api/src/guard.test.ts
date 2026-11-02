import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiErrorSchema, courseListResponseSchema, courseSchema, teamSchema } from "@teamplanet/contracts";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "../../../tests/helpers/d1";
import { authPolicy } from "./auth";
import { owned, type OwnedKind, type ProtectedEnv } from "./guard";
import { createApp, type Bindings } from "./index";
import type { Context } from "hono";

const ORIGIN = "https://teamplanet.cloby.co";
const [profA, profB] = fixtures.professors;
const [teamA, teamB] = fixtures.teams;
const run = (index: number) => `run_synthetic_${index}`;
const evidence = (index: number) => `evidence_synthetic_${index}`;
const ids: Record<OwnedKind, [string, string]> = {
  course: [fixtures.courses[0]!.id, fixtures.courses[1]!.id],
  team: [teamA!.id, teamB!.id],
  student: [fixtures.students[0]!.id, fixtures.students[1]!.id],
  run: [run(1), run(2)],
  evidence: [evidence(1), evidence(2)],
};
let clock: number;
let database: ReturnType<typeof sqliteD1>;
let codes: string[];
let app: ReturnType<typeof createApp>;
let env: Bindings;

beforeEach(() => {
  clock = Date.parse("2026-10-27T00:00:00.000Z");
  database = sqliteD1();
  const sql = database.sqlite;
  for (const p of fixtures.professors) sql.run("INSERT INTO professors VALUES (?, ?, ?)", [p.id, p.email, Date.parse(p.createdAt)]);
  for (const c of fixtures.courses) sql.run("INSERT INTO courses (id, professor_id, name, created_at) VALUES (?, ?, ?, ?)", [c.id, c.professorId, c.name, 0]);
  sql.run("INSERT INTO workspaces (id, slack_team_id, created_at) VALUES (?, ?, 0)", [fixtures.workspace.id, fixtures.workspace.slackTeamId]);
  fixtures.teams.forEach((t, i) => {
    sql.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name, collection_status) VALUES (?, ?, ?, ?, ?, ?)",
      [t.id, t.courseId, t.workspaceId, t.channelId, t.name, t.collectionStatus]);
    sql.run("INSERT INTO students (id, course_id, display_name, created_at) VALUES (?, ?, ?, 0)", [fixtures.students[i]!.id, t.courseId, fixtures.students[i]!.displayName]);
    sql.run("INSERT INTO analysis_runs (id, team_id, from_ts, to_ts, status, created_by) VALUES (?, ?, 'a', 'b', 'finalized', ?)", [run(i + 1), t.id, fixtures.professors[i]!.id]);
    sql.run("INSERT INTO evidence_events (id, run_id, message_ids_json, actor_ids_json, summary, tags_json) VALUES (?, ?, '[]', '[]', 'synthetic summary', '[]')", [evidence(i + 1), run(i + 1)]);
  });
  codes = [];
  app = createApp({ now: () => clock, sleep: async () => {}, policy: authPolicy, mailer: () => async mail => { codes.push(mail.code); } });
  env = { DB: database.db } as Bindings;
});
afterEach(() => database.sqlite.close());

function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
  if (init.cookie) headers.Cookie = init.cookie;
  return app.request(`${ORIGIN}/v1${path}`, {
    method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }, env);
}
async function login(email: string) {
  const { challengeId } = await (await call("/auth/otp/request", { method: "POST", body: { email } })).json() as { challengeId: string };
  const response = await call("/auth/otp/verify", { method: "POST", body: { challengeId, code: codes.at(-1) } });
  return response.headers.get("Set-Cookie")!.split(";")[0]!;
}
const auditRows = () => database.sqlite.query("SELECT actor_professor_id, action, target_type, target_id, result FROM audit_events ORDER BY id").all();
const count = (table: string) => (database.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("ownership resolves course, team, student, run and evidence only for the owning professor", async () => {
  const lookups: Record<string, boolean> = {};
  for (const [index, professor] of [profA!, profB!].entries()) {
    const context = { env, get: () => professor } as unknown as Context<ProtectedEnv>;
    for (const kind of Object.keys(ids) as OwnedKind[]) {
      lookups[`${index}:${kind}:own`] = (await owned(context, kind, ids[kind][index]!)) !== null;
      lookups[`${index}:${kind}:other`] = (await owned(context, kind, ids[kind][1 - index]!)) !== null;
    }
  }
  expect(Object.entries(lookups).filter(([key]) => key.endsWith(":own")).every(([, found]) => found)).toBe(true);
  expect(Object.entries(lookups).filter(([key]) => key.endsWith(":other")).some(([, found]) => found)).toBe(false);
});

test("professor A cannot read professor B's team and gets the same 404 as a missing team", async () => {
  const cookie = await login(profA!.email);
  const own = await call(`/teams/${teamA!.id}`, { cookie });
  expect(teamSchema.parse(await own.json())).toEqual(teamA!);

  const other = await call(`/teams/${teamB!.id}`, { cookie });
  const missing = await call("/teams/team_00000000-0000-4000-8000-0000000000ff", { cookie });
  expect([other.status, missing.status]).toEqual([404, 404]);
  const [otherError, missingError] = [apiErrorSchema.parse(await other.json()).error, apiErrorSchema.parse(await missing.json()).error];
  expect({ ...otherError, requestId: "" }).toEqual({ ...missingError, requestId: "" });
  expect(JSON.stringify(otherError)).not.toContain(teamB!.name);

  expect((await call("/teams/not-an-id", { cookie })).status).toBe(400);
  expect(auditRows()).toEqual([
    { actor_professor_id: profA!.id, action: "team.read", target_type: "team", target_id: teamA!.id, result: "succeeded" },
    { actor_professor_id: profA!.id, action: "team.read", target_type: "team", target_id: teamB!.id, result: "denied" },
    { actor_professor_id: profA!.id, action: "team.read", target_type: "team", target_id: "team_00000000-0000-4000-8000-0000000000ff", result: "denied" },
  ]);
});

test("courses are created for the session professor only and listed per professor", async () => {
  const cookieA = await login(profA!.email);
  const created = await call("/courses", { method: "POST", cookie: cookieA, body: { name: "새 합성 수업" } });
  expect(created.status).toBe(201);
  const course = courseSchema.parse(await created.json());
  expect(course.professorId).toBe(profA!.id);

  // A client-chosen owner is rejected outright, not silently ignored.
  const forged = await call("/courses", { method: "POST", cookie: cookieA, body: { name: "x", professorId: profB!.id } });
  expect(forged.status).toBe(400);

  clock += authPolicy.resendCooldownMs;
  const cookieB = await login(profB!.email);
  const listA = courseListResponseSchema.parse(await (await call("/courses", { cookie: cookieA })).json());
  const listB = courseListResponseSchema.parse(await (await call("/courses", { cookie: cookieB })).json());
  expect(listA.courses.map(c => c.id)).toEqual([fixtures.courses[0]!.id, course.id]);
  expect(listB.courses.map(c => c.id)).toEqual([fixtures.courses[1]!.id]);
  expect(auditRows()).toEqual([
    { actor_professor_id: profA!.id, action: "course.create", target_type: "course", target_id: course.id, result: "succeeded" },
  ]);
});

test("unauthenticated, expired and cross-origin requests are blocked before any write", async () => {
  const before = count("courses");
  const anonymous = await call("/courses", { method: "POST", body: { name: "x" } });
  expect(apiErrorSchema.parse(await anonymous.json()).error.code).toBe("UNAUTHENTICATED");
  expect((await call(`/teams/${teamA!.id}`)).status).toBe(401);
  // Default deny also covers routes that do not exist yet.
  expect((await call("/analysis-runs/run_synthetic_1")).status).toBe(401);

  const cookie = await login(profA!.email);
  const crossOrigin = await app.request(`${ORIGIN}/v1/courses`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example", Cookie: cookie },
    body: JSON.stringify({ name: "x" }),
  }, env);
  expect(crossOrigin.status).toBe(403);

  clock += authPolicy.sessionTtlMs;
  expect((await call("/courses", { method: "POST", cookie, body: { name: "x" } })).status).toBe(401);
  expect(count("courses")).toBe(before);
  expect(count("audit_events")).toBe(0);
});

test("audit rows hold only IDs and enums: no OTP, session token or student text", async () => {
  const cookie = await login(profA!.email);
  await call("/courses", { method: "POST", cookie, body: { name: "비밀 수업 이름" } });
  await call(`/teams/${teamB!.id}`, { cookie });
  const stored = JSON.stringify(database.sqlite.query("SELECT * FROM audit_events").all());
  for (const secret of [codes[0]!, cookie.split("=")[1]!, "비밀 수업 이름", "synthetic summary", teamB!.name]) {
    expect(stored).not.toContain(secret);
  }
  expect(() => database.sqlite.run(
    "INSERT INTO audit_events (actor_professor_id, action, target_type, target_id, result, recorded_at) VALUES (?, 'team.read', 'team', ?, 'leaked', 0)",
    [profA!.id, teamA!.id],
  )).toThrow();
});

test("health and auth stay reachable without a session", async () => {
  expect((await call("/health")).status).not.toBe(401);
  expect((await call("/auth/me")).status).toBe(401);
  expect(apiErrorSchema.parse(await (await call("/auth/me")).json()).error.code).toBe("UNAUTHENTICATED");
  expect((await call("/auth/otp/request", { method: "POST", body: { email: profA!.email } })).status).toBe(202);
});
