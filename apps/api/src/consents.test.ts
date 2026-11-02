import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  activateTeamResponseSchema, apiErrorSchema, collectionStatusResponseSchema, consentConfirmationIssueResponseSchema,
  consentConfirmationLookupResponseSchema, consentSchema, coursePilotResponseSchema,
} from "@teamplanet/contracts";
import { collectionGate } from "@teamplanet/collection";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "../../../tests/helpers/d1";
import { authPolicy } from "./auth";
import { createApp, type Bindings } from "./index";
import { sealToken } from "./slack";

// Synthetic people and Slack IDs only. `pilot-form-v1` stands in for an operator-approved form in this test database.
const ORIGIN = "https://teamplanet.cloby.co";
const [profA, profB] = fixtures.professors;
const [courseA] = fixtures.courses;
const WORKSPACE = fixtures.workspace;
const TEAM = "team_00000000-0000-4000-8000-0000000000a1";
const STUDENT = "student_00000000-0000-4000-8000-0000000000a1";
const BOT = "USYNTHBOT1";
const USER = "USYNTHSTU1";
const FORM = "pilot-form-v1";
const DAY = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

let clock: number;
let database: ReturnType<typeof sqliteD1>;
let codes: string[];
let env: Bindings;
let slackCalls: string[];
let channelMembers: string[];
let app: ReturnType<typeof createApp>;

const json = (body: unknown) => new Response(JSON.stringify(body));
beforeEach(async () => {
  clock = Date.parse("2026-10-28T00:00:00.000Z");
  database = sqliteD1();
  const sql = database.sqlite;
  for (const p of fixtures.professors) sql.run("INSERT INTO professors VALUES (?, ?, ?)", [p.id, p.email, Date.parse(p.createdAt)]);
  for (const c of fixtures.courses) sql.run("INSERT INTO courses (id, professor_id, name, created_at) VALUES (?, ?, ?, 0)", [c.id, c.professorId, c.name]);
  sql.run("INSERT INTO consent_policies VALUES (?, 0, 'operator-synthetic')", [FORM]);
  sql.run("INSERT INTO consent_policies VALUES ('pilot-form-v2', 0, 'operator-synthetic')");
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  sql.run("INSERT INTO workspaces (id, slack_team_id, created_at) VALUES (?, ?, 0)", [WORKSPACE.id, WORKSPACE.slackTeamId]);
  sql.run(`INSERT INTO slack_installations (workspace_id, team_name, app_id, bot_user_id, scopes, token_ciphertext,
    installed_by_slack_user_id, installed_by_professor_id, installed_at) VALUES (?, 'x', 'ASYNTH0001', ?, '', ?, 'USYNTHPROF', ?, 0)`,
    [WORKSPACE.id, BOT, await sealToken(key, WORKSPACE.id, "xoxb-synthetic"), profA!.id]);
  sql.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name) VALUES (?, ?, ?, 'CSYNTHCH01', '1조')", [TEAM, courseA!.id, WORKSPACE.id]);
  sql.run("INSERT INTO students (id, course_id, display_name, created_at) VALUES (?, ?, '합성 학생', 0)", [STUDENT, courseA!.id]);
  sql.run("INSERT INTO slack_users VALUES (?, ?)", [WORKSPACE.id, USER]);
  sql.run("INSERT INTO student_slack_mappings VALUES (?, ?, ?, ?)", [STUDENT, courseA!.id, WORKSPACE.id, USER]);
  sql.run("INSERT INTO team_members VALUES (?, ?, ?, ?)", [TEAM, STUDENT, courseA!.id, WORKSPACE.id]);
  codes = [];
  slackCalls = [];
  channelMembers = [BOT, USER];

  app = createApp(
    { now: () => clock, sleep: async () => {}, policy: authPolicy, mailer: () => async mail => { codes.push(mail.code); } },
    async url => {
      const method = url.replace("https://slack.com/api/", "");
      slackCalls.push(method);
      if (method === "conversations.info") return json({ ok: true, channel: { is_member: true, is_archived: false } });
      if (method === "conversations.members") return json({ ok: true, members: channelMembers });
      throw new Error(`unexpected Slack call ${method}`);
    },
  );
  env = { DB: database.db, SLACK_TOKEN_KEY: key } as Bindings;
});
afterEach(() => database.sqlite.close());

function call(path: string, cookie: string | undefined, body?: unknown, method = body === undefined ? "GET" : "POST", origin = ORIGIN) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (cookie) headers.Cookie = cookie;
  return app.request(`${ORIGIN}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
}
async function login(email: string) {
  const request = await call("/auth/otp/request", undefined, { email });
  const { challengeId } = await request.json() as { challengeId: string };
  const verify = await call("/auth/otp/verify", undefined, { challengeId, code: codes.at(-1) });
  clock += authPolicy.resendCooldownMs;
  return verify.headers.get("Set-Cookie")!.split(";")[0]!;
}
const code = async (response: Response) => apiErrorSchema.parse(await response.json()).error.code;
const setPilot = (cookie: string, consentVersion = FORM, endsAt = new Date(clock + 60 * DAY).toISOString()) =>
  call(`/courses/${courseA!.id}/pilot`, cookie, { consentVersion, endsAt }, "PUT");
const setConsent = (cookie: string, status: string, extra: Record<string, unknown> = { evidenceRef: "form-0001" }) =>
  call(`/teams/${TEAM}/consents/${STUDENT}`, cookie, { status, version: FORM, ...extra }, "PUT");
async function studentConfirms(cookie: string) {
  const issued = consentConfirmationIssueResponseSchema.parse(await (await call(`/teams/${TEAM}/consents/${STUDENT}/confirmation`, cookie, {})).json());
  const token = new URL(issued.confirmationUrl).hash.slice(1);
  expect((await call("/consent-confirmations/confirm", undefined, { token, confirmed: true })).status).toBe(200);
  return token;
}
const activate = (cookie: string, body: unknown = {}) => call(`/teams/${TEAM}/activate`, cookie, body);
const status = async (cookie: string) => collectionStatusResponseSchema.parse(await (await call(`/teams/${TEAM}/collection`, cookie)).json());
const audits = (action: string) => database.sqlite.query("SELECT result FROM audit_events WHERE action = ? ORDER BY id").all(action).map(r => (r as { result: string }).result);

test("pilot settings need an operator-approved form version and a future course end", async () => {
  const cookie = await login(profA!.email);
  expect(await code(await setPilot(cookie, "synthetic-policy-v1"))).toBe("POLICY_NOT_APPROVED"); // the fixture version is not approved
  expect(await code(await setPilot(cookie, FORM, new Date(clock - DAY).toISOString()))).toBe("VALIDATION_ERROR");
  const saved = coursePilotResponseSchema.parse(await (await setPilot(cookie)).json());
  expect(saved).toMatchObject({ courseId: courseA!.id, consentVersion: FORM, policyApproved: true });
  const cookieB = await login(profB!.email);
  expect((await setPilot(cookieB)).status).toBe(404);
});

test("activation is refused without policy, consent, student re-confirmation or complete membership, and flags cannot bypass it", async () => {
  const cookie = await login(profA!.email);
  expect(await code(await activate(cookie))).toBe("POLICY_NOT_APPROVED");
  expect(await code(await setConsent(cookie, "granted"))).toBe("POLICY_NOT_APPROVED"); // no form set yet
  await setPilot(cookie);
  expect(await code(await activate(cookie))).toBe("CONSENT_REQUIRED"); // no consent at all
  expect(await code(await call(`/teams/${TEAM}/consents/${STUDENT}`, cookie, { status: "granted", version: "pilot-form-v2", evidenceRef: "f" }, "PUT"))).toBe("POLICY_NOT_APPROVED");
  expect(await code(await setConsent(cookie, "granted", {}))).toBe("VALIDATION_ERROR"); // evidence reference required
  expect((await setConsent(cookie, "granted")).status).toBe(200);
  expect(await code(await activate(cookie))).toBe("CONSENT_REQUIRED"); // paper consent alone is not enough

  await studentConfirms(cookie);
  channelMembers = [BOT, USER, "USYNTHNEW1"];
  expect(await code(await activate(cookie))).toBe("CHANNEL_MEMBERSHIP_REQUIRED");
  channelMembers = [BOT, USER];
  for (const bypass of [{ consentApproved: true }, { collectionStatus: "active" }]) expect(await code(await activate(cookie, bypass))).toBe("VALIDATION_ERROR");
  expect(await code(await call(`/teams/${TEAM}/consents/${STUDENT}`, cookie, { status: "granted", version: FORM, evidenceRef: "f", recordedAt: new Date(clock).toISOString() }, "PUT"))).toBe("VALIDATION_ERROR");

  expect((await status(cookie)).collectionStatus).toBe("inactive");
  expect(audits("team.activate")).toEqual(["denied", "denied", "denied", "denied"]);
  const cookieB = await login(profB!.email);
  expect((await activate(cookieB)).status).toBe(404);
  expect(slackCalls.every(m => m === "conversations.info" || m === "conversations.members")).toBe(true);
});

test("consent → withdraw → re-consent keeps history, closes and reopens windows and needs a fresh student confirmation", async () => {
  const cookie = await login(profA!.email);
  await setPilot(cookie);
  await setConsent(cookie, "granted");
  const firstToken = await studentConfirms(cookie);
  const activated = activateTeamResponseSchema.parse(await (await activate(cookie)).json());
  expect(activated.activatedAt).toBe(new Date(clock).toISOString());
  clock += 1000;
  expect(activateTeamResponseSchema.parse(await (await activate(cookie)).json()).activatedAt).toBe(activated.activatedAt); // idempotent

  clock += HOUR;
  const withdrawn = consentSchema.parse(await (await setConsent(cookie, "withdrawn", {})).json());
  expect(withdrawn.status).toBe("withdrawn");
  expect(await status(cookie)).toMatchObject({ collectionStatus: "paused", windows: [{ endReason: "consent_changed", endedAt: new Date(clock).toISOString() }] });

  clock += HOUR;
  const regranted = consentSchema.parse(await (await setConsent(cookie, "granted", { evidenceRef: "form-0002" })).json());
  expect(regranted.studentConfirmedAt).toBeNull(); // the first confirmation belonged to the first grant
  expect((await call("/consent-confirmations/confirm", undefined, { token: firstToken, confirmed: true })).status).toBe(200); // replay is a no-op
  expect(await code(await activate(cookie))).toBe("CONSENT_REQUIRED");
  await studentConfirms(cookie);
  clock += 1000;
  expect((await activate(cookie)).status).toBe(200);

  const windows = (await status(cookie)).windows;
  expect(windows.map(w => w.endReason)).toEqual(["consent_changed", null]);
  const history = database.sqlite.query(`SELECT h.status, e.actor_professor_id, e.evidence_ref FROM consent_history h
    JOIN consent_evidence e ON e.history_id = h.id WHERE h.team_id = ? ORDER BY h.id`).all(TEAM);
  expect(history).toEqual([
    { status: "granted", actor_professor_id: profA!.id, evidence_ref: "form-0001" },
    { status: "withdrawn", actor_professor_id: profA!.id, evidence_ref: null },
    { status: "granted", actor_professor_id: profA!.id, evidence_ref: "form-0002" },
  ]);
  // A repeated identical PUT writes no history and keeps the student confirmation valid.
  await setConsent(cookie, "granted", { evidenceRef: "form-0002" });
  expect((database.sqlite.query("SELECT COUNT(*) AS n FROM consent_history").get() as { n: number }).n).toBe(3);
  expect((await status(cookie)).collectionStatus).toBe("active");

  // Past allowed intervals are reconstructable: the first window covers activation → withdrawal only.
  const gate = (at: number) => collectionGate(database.db, { teamId: TEAM, at, now: clock, slackUserId: USER });
  expect(await gate(Date.parse(activated.activatedAt) + 1)).toEqual({ allowed: true, studentId: STUDENT });
  expect(await gate(Date.parse(windows[0]!.endedAt!) + 1)).toEqual({ allowed: false, reason: "outside_window" });
  expect(await collectionGate(database.db, { teamId: TEAM, at: clock, now: clock, slackUserId: "USYNTHNEW1" })).toEqual({ allowed: false, reason: "unknown_participant" });
});

test("a withdrawal racing activation is never activated over", async () => {
  const cookie = await login(profA!.email);
  await setPilot(cookie);
  await setConsent(cookie, "granted");
  await studentConfirms(cookie);
  // The withdrawal lands after every pre-check passed, right before the activation write.
  const real = database.db;
  env = { ...env, DB: {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (statements: Parameters<typeof real.batch>[0]) => {
      database.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = ? WHERE team_id = ?", [clock, TEAM]);
      return real.batch(statements);
    },
  } as unknown as Bindings["DB"] };
  expect(await code(await activate(cookie))).toBe("CONSENT_REQUIRED");
  env = { ...env, DB: real };
  expect(await status(cookie)).toEqual({ teamId: TEAM, collectionStatus: "inactive", windows: [] });
});

test("student confirmation links are personal, single use, expire, and die with the grant they were issued for", async () => {
  const cookie = await login(profA!.email);
  await setPilot(cookie);
  expect(await code(await call(`/teams/${TEAM}/consents/${STUDENT}/confirmation`, cookie, {}))).toBe("CONSENT_REQUIRED");
  await setConsent(cookie, "granted");
  const issued = consentConfirmationIssueResponseSchema.parse(await (await call(`/teams/${TEAM}/consents/${STUDENT}/confirmation`, cookie, {})).json());
  const url = new URL(issued.confirmationUrl);
  expect(url.pathname).toBe("/consent/confirm");
  const token = url.hash.slice(1);
  expect(JSON.stringify(database.sqlite.query("SELECT * FROM consent_confirmations").all())).not.toContain(token);

  const lookup = consentConfirmationLookupResponseSchema.parse(await (await call("/consent-confirmations/lookup", undefined, { token })).json());
  expect(lookup).toMatchObject({ courseName: courseA!.name, teamName: "1조", studentDisplayName: "합성 학생", version: FORM, confirmedAt: null });
  expect((await call("/consent-confirmations/lookup", undefined, { token: "x".repeat(43) })).status).toBe(404);
  expect((await call("/consent-confirmations/confirm", undefined, { token, confirmed: false })).status).toBe(400);
  expect((await call("/consent-confirmations/confirm", undefined, { token, confirmed: true }, "POST", "https://evil.example")).status).toBe(403);

  // Withdrawn before the student clicks: the old link no longer confirms anything.
  await setConsent(cookie, "withdrawn", {});
  expect((await call("/consent-confirmations/confirm", undefined, { token, confirmed: true })).status).toBe(404);

  await setConsent(cookie, "granted", { evidenceRef: "form-0002" });
  const late = consentConfirmationIssueResponseSchema.parse(await (await call(`/teams/${TEAM}/consents/${STUDENT}/confirmation`, cookie, {})).json());
  clock += 8 * DAY;
  expect((await call("/consent-confirmations/confirm", undefined, { token: new URL(late.confirmationUrl).hash.slice(1), confirmed: true })).status).toBe(404);
  const consents = await (await call(`/teams/${TEAM}/consents`, await login(profA!.email))).json() as { consents: { studentConfirmedAt: string | null }[] };
  expect(consents.consents[0]!.studentConfirmedAt).toBeNull();
});

test("changing the course form version or deactivating stops collection; the gate follows", async () => {
  const cookie = await login(profA!.email);
  await setPilot(cookie);
  await setConsent(cookie, "granted");
  await studentConfirms(cookie);
  await activate(cookie);
  expect(await collectionGate(database.db, { teamId: TEAM, at: clock, now: clock, slackUserId: USER })).toMatchObject({ allowed: true });

  clock += 1000;
  await setPilot(cookie, "pilot-form-v2");
  expect(await status(cookie)).toMatchObject({ collectionStatus: "paused", windows: [{ endReason: "policy_changed" }] });
  expect(await collectionGate(database.db, { teamId: TEAM, at: clock, now: clock, slackUserId: USER })).toEqual({ allowed: false, reason: "team_inactive" });
  expect(await code(await activate(cookie))).toBe("CONSENT_REQUIRED"); // consents were on the old form

  // Back on the original form the earlier grant and confirmation count again; then the professor stops it.
  await setPilot(cookie, FORM);
  clock += 1000;
  expect((await activate(cookie)).status).toBe(200);
  const stopped = collectionStatusResponseSchema.parse(await (await call(`/teams/${TEAM}/deactivate`, cookie, {})).json());
  expect(stopped).toMatchObject({ collectionStatus: "paused" });
  expect(stopped.windows.map(w => w.endReason)).toEqual(["policy_changed", "professor"]);
  expect(audits("team.deactivate")).toEqual(["succeeded"]);
});
