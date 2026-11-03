import { afterEach, beforeEach, expect, test } from "bun:test";
import { courseRubricResponseSchema, rubricSelectionSchema, type RubricSelection } from "@teamplanet/contracts";
import { professors, courses } from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "../../../tests/helpers/d1";
import { createApp, type Bindings } from "./index";
import { authPolicy } from "./auth";

const origin = "https://teamplanet.cloby.co";
let db: ReturnType<typeof sqliteD1>;
let app: ReturnType<typeof createApp>;
let env: Bindings;
let now: number;
let code: string;
const selection: RubricSelection = { rubricVersion: "communication-v1", selectedCompetencies: ["clarity"] };
beforeEach(() => {
  now = Date.parse("2026-11-02T00:00:00.000Z"); db = sqliteD1();
  for (const p of professors) db.sqlite.run("INSERT INTO professors VALUES (?, ?, ?)", [p.id, p.email, 0]);
  for (const c of courses) db.sqlite.run("INSERT INTO courses (id, professor_id, name, created_at) VALUES (?, ?, ?, ?)", [c.id, c.professorId, c.name, 0]);
  app = createApp({ now: () => now, sleep: async () => {}, policy: authPolicy, mailer: () => async mail => { code = mail.code; } });
  env = { DB: db.db } as Bindings;
});
afterEach(() => db.sqlite.close());
const target = (id = courses[0]!.id) => `/courses/${id}/rubric`;
function call(path: string, method = "GET", body?: unknown, cookie = "", requestOrigin = origin) {
  return app.request(origin + "/v1" + path, { method, headers: { Origin: requestOrigin, Cookie: cookie, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
}
async function login() {
  const challenge = await (await call("/auth/otp/request", "POST", { email: professors[0]!.email })).json() as { challengeId: string };
  const response = await call("/auth/otp/verify", "POST", { challengeId: challenge.challengeId, code });
  return response.headers.get("Set-Cookie")!.split(";")[0]!;
}
const count = () => (db.sqlite.query("SELECT count(*) AS n FROM course_rubric_settings").get() as { n: number }).n;

test("unset selection stays null; save and reload preserves only explicitly selected competencies", async () => {
  const cookie = await login();
  const initial = courseRubricResponseSchema.parse(await (await call(target(), "GET", undefined, cookie)).json());
  expect(initial).toEqual({ courseId: courses[0]!.id, selection: null, updatedAt: null });
  expect(count()).toBe(0);
  expect((await call(target(), "PUT", selection, cookie)).status).toBe(200);
  const saved = courseRubricResponseSchema.parse(await (await call(target(), "GET", undefined, cookie)).json());
  expect(saved.selection).toEqual(selection); expect(saved.updatedAt).toBe(new Date(now).toISOString());
  expect(count()).toBe(1);
  const audit = db.sqlite.query("SELECT actor_professor_id, action, target_id, result FROM audit_events").all();
  expect(audit).toEqual([{ actor_professor_id: professors[0]!.id, action: "course.rubric_set", target_id: courses[0]!.id, result: "succeeded" }]);
});

test("invalid, duplicate, unknown, empty and forged owner inputs never write settings", async () => {
  const cookie = await login();
  for (const body of [null, {}, { ...selection, selectedCompetencies: [] }, { ...selection, selectedCompetencies: ["clarity", "clarity"] },
    { ...selection, selectedCompetencies: ["productivity"] }, { ...selection, rubricVersion: "unknown" }, { ...selection, professorId: professors[1]!.id }]) {
    expect((await call(target(), "PUT", body, cookie)).status).toBe(400);
  }
  expect(count()).toBe(0);
});

test("other professor's course and missing course share 404 for reads and writes", async () => {
  const cookie = await login();
  for (const method of ["GET", "PUT"]) for (const id of [courses[1]!.id, "course_00000000-0000-4000-8000-0000000000ff"]) {
    const response = await call(target(id), method, method === "PUT" ? selection : undefined, cookie);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain(courses[1]!.name);
  }
  expect(count()).toBe(0);
  expect(db.sqlite.query("SELECT result FROM audit_events").all()).toEqual(Array.from({ length: 4 }, () => ({ result: "denied" })));
});

test("unauthenticated, expired and cross-origin writes fail before settings or audit changes", async () => {
  expect((await call(target(), "PUT", selection)).status).toBe(401);
  const cookie = await login();
  expect((await call(target(), "PUT", selection, cookie, "https://evil.invalid")).status).toBe(403);
  now += authPolicy.sessionTtlMs;
  expect((await call(target(), "PUT", selection, cookie)).status).toBe(401);
  expect(count()).toBe(0); expect(db.sqlite.query("SELECT * FROM audit_events").all()).toEqual([]);
});

test("updating settings does not overwrite existing run/assessment data or consent history", async () => {
  const cookie = await login();
  db.sqlite.run("INSERT INTO analysis_runs (id, team_id, from_ts, to_ts, status, created_by, stage_metadata_json) VALUES ('legacy-run', 'legacy-team', 'a', 'b', 'finalized', ?, '{\"selectedCompetencies\":[\"clarity\"]}')", [professors[0]!.id]);
  db.sqlite.run(`INSERT INTO assessments VALUES ('legacy-assessment', 'legacy-run', 'legacy-student', 'clarity', 'insufficient_evidence', 'synthetic assessment', '[]', '[]', '["synthetic limitation"]', 1, 'low', '{"reviewed":true}')`);
  db.sqlite.run("INSERT INTO consents VALUES ('legacy-team', 'legacy-student', 'granted', 'synthetic-policy', 0)");
  const before = ["assessments", "analysis_runs", "consent_history"].map(table => db.sqlite.query(`SELECT * FROM ${table}`).all());
  await call(target(), "PUT", selection, cookie);
  now += 1000;
  const next: RubricSelection = { ...selection, selectedCompetencies: ["information_sharing", "decision_execution"] };
  await call(target(), "PUT", next, cookie);
  expect(count()).toBe(1);
  expect(courseRubricResponseSchema.parse(await (await call(target(), "GET", undefined, cookie)).json()).selection).toEqual(next);
  expect(["assessments", "analysis_runs", "consent_history"].map(table => db.sqlite.query(`SELECT * FROM ${table}`).all())).toEqual(before);
  db.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = 1 WHERE team_id = 'legacy-team'");
  expect((db.sqlite.query("SELECT count(*) AS n FROM consent_history").get() as { n: number }).n).toBe(2);
  expect(db.sqlite.query("SELECT * FROM sqlite_master WHERE type='trigger' AND name LIKE 'consents_%'").all().length).toBeGreaterThan(0);
});

test("audit failure rolls back the setting write; malformed stored selections fail closed", async () => {
  const cookie = await login();
  db.sqlite.run("CREATE TRIGGER reject_rubric_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
  expect((await call(target(), "PUT", selection, cookie)).status).toBe(500); expect(count()).toBe(0);
  db.sqlite.run("DROP TRIGGER reject_rubric_audit");
  db.sqlite.run("INSERT INTO course_rubric_settings VALUES (?, 'communication-v1', '[\"made_up\"]', ?)", [courses[0]!.id, now]);
  expect((await call(target(), "GET", undefined, cookie)).status).toBe(500);
  expect(rubricSelectionSchema.safeParse({ ...selection, selectedCompetencies: ["made_up"] }).success).toBe(false);
});
