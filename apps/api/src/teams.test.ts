import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  apiErrorSchema, inviteTeamResponseSchema, studentSchema, teamMemberSchema, teamMembershipSchema, teamSchema,
} from "@teamplanet/contracts";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "../../../tests/helpers/d1";
import { authPolicy } from "./auth";
import { createApp, type Bindings } from "./index";
import { sealToken } from "./slack";
import { channelName } from "./teams";

// Synthetic Slack IDs only. The fake Slack answers per method; tests swap handlers to model failures.
const ORIGIN = "https://teamplanet.cloby.co";
const [profA, profB] = fixtures.professors;
const [courseA, courseB] = fixtures.courses;
const WORKSPACE = fixtures.workspace;
const BOT = "USYNTHBOT1";
const CHANNEL = "CSYNTHCH01";
const USER = "USYNTHSTU1";

type Params = Record<string, string>;
let clock: number;
let database: ReturnType<typeof sqliteD1>;
let codes: string[];
let env: Bindings;
let calls: { method: string; params: Params }[];
let slack: Record<string, (params: Params) => Response>;
let app: ReturnType<typeof createApp>;

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);
const publicChannel = (extra: Record<string, unknown> = {}) => json({
  ok: true, channel: { id: CHANNEL, is_channel: true, is_private: false, is_archived: false, is_im: false, is_mpim: false, is_shared: false, is_ext_shared: false, is_member: true, ...extra },
});

beforeEach(async () => {
  clock = Date.parse("2026-10-28T00:00:00.000Z");
  database = sqliteD1();
  const sql = database.sqlite;
  for (const p of fixtures.professors) sql.run("INSERT INTO professors VALUES (?, ?, ?)", [p.id, p.email, Date.parse(p.createdAt)]);
  for (const c of fixtures.courses) sql.run("INSERT INTO courses (id, professor_id, name, created_at) VALUES (?, ?, ?, 0)", [c.id, c.professorId, c.name]);
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  sql.run("INSERT INTO workspaces (id, slack_team_id, created_at) VALUES (?, ?, 0)", [WORKSPACE.id, WORKSPACE.slackTeamId]);
  sql.run(`INSERT INTO slack_installations (workspace_id, team_name, app_id, bot_user_id, scopes, token_ciphertext,
    installed_by_slack_user_id, installed_by_professor_id, installed_at) VALUES (?, '합성 파일럿', 'ASYNTH0001', ?, '', ?, 'USYNTHPROF', ?, 0)`,
    [WORKSPACE.id, BOT, await sealToken(key, WORKSPACE.id, "xoxb-synthetic"), profA!.id]);
  codes = [];
  calls = [];
  slack = {
    "conversations.info": () => publicChannel(),
    "conversations.join": () => json({ ok: true }),
    "conversations.create": params => json({ ok: true, channel: { id: "CSYNTHNEW1", name: params.name } }),
    "users.info": params => json({ ok: true, user: { id: params.user, team_id: WORKSPACE.slackTeamId, deleted: false, is_bot: false } }),
    "conversations.members": () => json({ ok: true, members: [BOT, USER], response_metadata: { next_cursor: "" } }),
    "conversations.invite": () => json({ ok: true }),
  };
  app = createApp(
    { now: () => clock, sleep: async () => {}, policy: authPolicy, mailer: () => async mail => { codes.push(mail.code); } },
    async (url, init) => {
      const method = url.replace("https://slack.com/api/", "");
      const params = Object.fromEntries(new URLSearchParams(String(init.body)));
      calls.push({ method, params });
      const handler = slack[method];
      if (!handler) throw new Error(`unexpected Slack call ${method}`);
      return handler(params);
    },
  );
  env = { DB: database.db, SLACK_TOKEN_KEY: key } as Bindings;
});
afterEach(() => database.sqlite.close());

function call(path: string, cookie: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`${ORIGIN}/v1${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }, env);
}
async function login(email: string) {
  const headers = { "Content-Type": "application/json", Origin: ORIGIN };
  const request = await app.request(`${ORIGIN}/v1/auth/otp/request`, { method: "POST", headers, body: JSON.stringify({ email }) }, env);
  const { challengeId } = await request.json() as { challengeId: string };
  const verify = await app.request(`${ORIGIN}/v1/auth/otp/verify`, { method: "POST", headers, body: JSON.stringify({ challengeId, code: codes.at(-1) }) }, env);
  clock += authPolicy.resendCooldownMs;
  return verify.headers.get("Set-Cookie")!.split(";")[0]!;
}
const errorOf = async (response: Response) => ({ status: response.status, code: apiErrorSchema.parse(await response.json()).error.code });
const count = (table: string) => (database.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const methods = () => calls.map(c => c.method);
const designate = (cookie: string, extra: Record<string, unknown> = {}) =>
  call("/teams", cookie, { method: "POST", body: { courseId: courseA!.id, workspaceId: WORKSPACE.id, channelId: CHANNEL, name: "1조", ...extra } });

async function teamWithStudent(cookie: string) {
  const team = teamSchema.parse(await (await designate(cookie)).json());
  const student = studentSchema.parse(await (await call(`/courses/${courseA!.id}/students`, cookie, { method: "POST", body: { displayName: "합성 학생" } })).json());
  return { team, student };
}
const setMember = (cookie: string, teamId: string, studentId: string, slackUserId = USER) =>
  call(`/teams/${teamId}/members/${studentId}`, cookie, { method: "PUT", body: { workspaceId: WORKSPACE.id, slackUserId } });

test("channel names follow the teamplanet-{course}-{team} template within Slack rules", () => {
  expect(channelName("Database 2026 / 봄", "Team A!")).toBe("teamplanet-database-2026-봄-team-a");
  expect(channelName("  ", "!!!")).toBe("teamplanet-course-team");
  const long = channelName("가".repeat(100), "b");
  expect(long.length).toBeLessThanOrEqual(80);
  expect(long.endsWith("-")).toBe(false);
});

test("designating an existing public channel joins the bot once; retries and duplicates never add a second record", async () => {
  const cookie = await login(profA!.email);
  slack["conversations.info"] = () => publicChannel({ is_member: false });
  const created = await designate(cookie);
  expect(created.status).toBe(201);
  expect(teamSchema.parse(await created.json())).toMatchObject({ channelId: CHANNEL, collectionStatus: "inactive", workspaceId: WORKSPACE.id });
  expect(methods()).toEqual(["conversations.info", "conversations.join"]);

  // Retry and the same channel under another name: 409 before any Slack call.
  expect(await errorOf(await designate(cookie))).toEqual({ status: 409, code: "CONFLICT" });
  expect(await errorOf(await designate(cookie, { name: "2조" }))).toEqual({ status: 409, code: "CONFLICT" });
  expect(methods()).toHaveLength(2);
  expect(count("teams")).toBe(1);

  const list = await (await call("/teams", cookie)).json() as { teams: unknown[] };
  expect(list.teams).toHaveLength(1);
  const cookieB = await login(profB!.email);
  expect(await (await call("/teams", cookieB)).json()).toEqual({ teams: [] });
  expect((await designate(cookieB, { channelId: "CSYNTHCH02", name: "남의 수업" })).status).toBe(404);
});

test("DM, private, archived, shared and missing channels are refused", async () => {
  const cookie = await login(profA!.email);
  expect((await designate(cookie, { channelId: "DSYNTHDM01" })).status).toBe(400);
  for (const extra of [{ is_private: true }, { is_archived: true }, { is_ext_shared: true }, { is_shared: true }, { is_channel: false, is_mpim: true }]) {
    slack["conversations.info"] = () => publicChannel(extra);
    const refused = await designate(cookie);
    expect(apiErrorSchema.parse(await refused.json()).error.issues?.[0]?.path).toEqual(["channelId"]);
  }
  slack["conversations.info"] = () => json({ ok: false, error: "channel_not_found" });
  expect((await designate(cookie)).status).toBe(400);
  expect(await errorOf(await designate(cookie, { workspaceId: "workspace_00000000-0000-4000-8000-0000000000ff" }))).toEqual({ status: 400, code: "VALIDATION_ERROR" });
  expect(count("teams")).toBe(0);
  expect(methods()).not.toContain("conversations.join");
});

test("creating a channel uses the template; name clashes and Slack limits are reported, not hidden", async () => {
  const cookie = await login(profA!.email);
  const noChannel = { channelId: undefined, name: "Team 1" };
  const created = await designate(cookie, noChannel);
  expect(created.status).toBe(201);
  expect(calls[0]).toEqual({ method: "conversations.create", params: { name: channelName(courseA!.name, "Team 1"), is_private: "false" } });
  expect(teamSchema.parse(await created.json()).channelId).toBe("CSYNTHNEW1");

  slack["conversations.create"] = () => json({ ok: false, error: "name_taken" });
  expect(await errorOf(await designate(cookie, { ...noChannel, name: "Team 2" }))).toEqual({ status: 409, code: "CONFLICT" });

  slack["conversations.create"] = () => json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "7" } });
  const limited = await designate(cookie, { ...noChannel, name: "Team 3" });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("7");

  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    slack["conversations.create"] = () => { throw new Error("network down"); };
    expect(await errorOf(await designate(cookie, { ...noChannel, name: "Team 4" }))).toEqual({ status: 503, code: "SLACK_UNAVAILABLE" });
    database.sqlite.run("UPDATE slack_installations SET token_ciphertext = NULL, revoked_at = 1");
    expect(await errorOf(await designate(cookie, { ...noChannel, name: "Team 5" }))).toEqual({ status: 503, code: "SLACK_UNAVAILABLE" });
  } finally {
    errors.mockRestore();
  }
  expect(count("teams")).toBe(1);
});

test("students are per owned course and mapping is idempotent, one Slack account per student and course", async () => {
  const cookie = await login(profA!.email);
  const { team, student } = await teamWithStudent(cookie);
  const cookieB = await login(profB!.email);
  expect((await call(`/courses/${courseA!.id}/students`, cookieB)).status).toBe(404);
  expect((await call(`/courses/${courseA!.id}/students`, cookieB, { method: "POST", body: { displayName: "x" } })).status).toBe(404);

  const first = await setMember(cookie, team.id, student.id);
  expect(teamMemberSchema.parse(await first.json())).toEqual({ teamId: team.id, studentId: student.id, courseId: courseA!.id, workspaceId: WORKSPACE.id, slackUserId: USER });
  const lookups = methods().filter(m => m === "users.info").length;
  expect((await setMember(cookie, team.id, student.id)).status).toBe(200);
  expect(methods().filter(m => m === "users.info").length).toBe(lookups); // retry needs no new Slack lookup
  expect([count("student_slack_mappings"), count("team_members")]).toEqual([1, 1]);

  expect(await errorOf(await setMember(cookie, team.id, student.id, "USYNTHSTU2"))).toEqual({ status: 409, code: "CONFLICT" });
  const other = studentSchema.parse(await (await call(`/courses/${courseA!.id}/students`, cookie, { method: "POST", body: { displayName: "다른 학생" } })).json());
  expect(await errorOf(await setMember(cookie, team.id, other.id, USER))).toEqual({ status: 409, code: "CONFLICT" });

  // Accounts that are not active humans of this workspace are refused.
  for (const user of [{ deleted: true }, { is_bot: true }, { team_id: "TSYNTHOTHER" }]) {
    slack["users.info"] = params => json({ ok: true, user: { id: params.user, team_id: WORKSPACE.slackTeamId, deleted: false, is_bot: false, ...user } });
    expect((await setMember(cookie, team.id, other.id, "USYNTHSTU3")).status).toBe(400);
  }
  slack["users.info"] = () => json({ ok: false, error: "user_not_found" });
  expect((await setMember(cookie, team.id, other.id, "USYNTHSTU3")).status).toBe(400);

  expect((await setMember(cookieB, team.id, student.id)).status).toBe(404);
  const members = await (await call(`/teams/${team.id}/members`, cookie)).json() as { members: unknown[] };
  expect(members.members).toHaveLength(1);
  expect((await call(`/teams/${team.id}/members`, cookieB)).status).toBe(404);
});

test("membership is complete only with the bot, every mapped student and no unknown account in the channel", async () => {
  const cookie = await login(profA!.email);
  const { team, student } = await teamWithStudent(cookie);
  const status = async () => teamMembershipSchema.parse(await (await call(`/teams/${team.id}/membership`, cookie)).json());

  expect((await status()).complete).toBe(false); // no mapped students yet
  await setMember(cookie, team.id, student.id);
  calls = [];
  expect(await status()).toEqual({
    teamId: team.id, checkedAt: new Date(clock).toISOString(), botInChannel: true,
    members: [{ studentId: student.id, slackUserId: USER, inChannel: true }], unmappedChannelMembers: [], complete: true,
  });
  expect(methods()).toEqual(["conversations.info", "conversations.members"]); // never history or files

  // A newcomer arrives on the second page.
  slack["conversations.members"] = params => params.cursor
    ? json({ ok: true, members: ["USYNTHNEW1"], response_metadata: { next_cursor: "" } })
    : json({ ok: true, members: [BOT, USER], response_metadata: { next_cursor: "page-2" } });
  expect(await status()).toMatchObject({ unmappedChannelMembers: ["USYNTHNEW1"], complete: false });

  slack["conversations.members"] = () => json({ ok: true, members: [BOT] });
  expect(await status()).toMatchObject({ members: [{ studentId: student.id, slackUserId: USER, inChannel: false }], complete: false });

  slack["conversations.members"] = () => json({ ok: true, members: [BOT, USER] });
  slack["conversations.info"] = () => publicChannel({ is_member: false });
  expect(await status()).toMatchObject({ botInChannel: false, complete: false });

  slack["conversations.info"] = () => json({ ok: false, error: "ratelimited" }, { status: 429 });
  expect((await call(`/teams/${team.id}/membership`, cookie)).status).toBe(429);
  const cookieB = await login(profB!.email);
  expect((await call(`/teams/${team.id}/membership`, cookieB)).status).toBe(404);
});

test("invites never report success they did not get and retries do not invite twice", async () => {
  const cookie = await login(profA!.email);
  const { team, student } = await teamWithStudent(cookie);
  const invite = async (studentId = student.id) => {
    const response = await call(`/teams/${team.id}/invite`, cookie, { method: "POST", body: { studentId } });
    return response.status === 200 ? inviteTeamResponseSchema.parse(await response.json()).status : response.status;
  };

  calls = [];
  expect(await invite()).toBe("manual_invite_required"); // no Slack account yet: the professor invites to the workspace by hand
  expect(calls).toEqual([]);

  await setMember(cookie, team.id, student.id);
  expect(await invite()).toBe("invited");
  expect(calls.at(-1)).toEqual({ method: "conversations.invite", params: { channel: CHANNEL, users: USER } });
  slack["conversations.invite"] = () => json({ ok: false, error: "already_in_channel" });
  expect(await invite()).toBe("already_member");
  slack["conversations.invite"] = () => json({ ok: false, error: "cant_invite" });
  expect(await invite()).toBe("manual_invite_required");
  slack["conversations.invite"] = () => json({ ok: false, error: "not_in_channel" });
  expect(await invite()).toBe(409);
  slack["conversations.invite"] = () => json({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "3" } });
  expect(await invite()).toBe(429);

  // Mapped in the course but not on this team.
  const other = studentSchema.parse(await (await call(`/courses/${courseA!.id}/students`, cookie, { method: "POST", body: { displayName: "다른 학생" } })).json());
  database.sqlite.run("INSERT INTO slack_users VALUES (?, 'USYNTHSTU9')", [WORKSPACE.id]);
  database.sqlite.run("INSERT INTO student_slack_mappings VALUES (?, ?, ?, 'USYNTHSTU9')", [other.id, courseA!.id, WORKSPACE.id]);
  expect(await invite(other.id)).toBe(409);
  expect(await invite(fixtures.students[1]!.id)).toBe(404);

  const audited = database.sqlite.query("SELECT action, target_type, result FROM audit_events WHERE action IN ('team.create', 'student.create', 'team.member_set', 'team.invite') ORDER BY id").all();
  expect(audited.slice(0, 4)).toEqual([
    { action: "team.create", target_type: "team", result: "succeeded" },
    { action: "student.create", target_type: "student", result: "succeeded" },
    { action: "team.invite", target_type: "student", result: "succeeded" },
    { action: "team.member_set", target_type: "student", result: "succeeded" },
  ]);
});
