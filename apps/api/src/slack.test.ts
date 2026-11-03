import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiErrorSchema, slackConnectionSchema } from "@teamplanet/contracts";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "../../../tests/helpers/d1";
import manifest from "../slack-manifest.json";
import { authPolicy } from "./auth";
import { createApp, type Bindings } from "./index";
import { openToken, sealToken, slackBotScopes } from "./slack";

// Synthetic Slack IDs and secrets only; no real workspace or token is used.
const ORIGIN = "https://teamplanet.cloby.co";
const TEAM = { id: "TSYNTH0001", name: "합성 파일럿" };
const OTHER_TEAM = { id: "TSYNTH0002", name: "다른 워크스페이스" };
const BOT_TOKEN = "xoxb-synthetic-bot-token";
const SECRET = "synthetic-client-secret";
const [profA, profB] = fixtures.professors;
const ALL_SCOPES = slackBotScopes.join(",");

let clock: number;
let database: ReturnType<typeof sqliteD1>;
let codes: string[];
let env: Bindings;
let calls: { url: string; init: RequestInit }[];
let slack: Record<string, () => Response | Promise<Response>>;
let app: ReturnType<typeof createApp>;

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers });
const grant = (team = TEAM, scope = ALL_SCOPES) => json({
  ok: true, access_token: BOT_TOKEN, token_type: "bot", scope, bot_user_id: "USYNTHBOT1", app_id: "ASYNTH0001",
  team, enterprise: null, is_enterprise_install: false, authed_user: { id: "USYNTHPROF" },
});

beforeEach(() => {
  clock = Date.parse("2026-10-28T00:00:00.000Z");
  database = sqliteD1();
  for (const p of fixtures.professors) database.sqlite.run("INSERT INTO professors VALUES (?, ?, ?)", [p.id, p.email, Date.parse(p.createdAt)]);
  codes = [];
  calls = [];
  slack = {
    "oauth.v2.access": () => grant(),
    "auth.test": () => json({ ok: true, team_id: TEAM.id }, { "x-oauth-scopes": ALL_SCOPES }),
  };
  app = createApp(
    { now: () => clock, sleep: async () => {}, policy: authPolicy, mailer: () => async mail => { codes.push(mail.code); } },
    async (url, init) => {
      calls.push({ url, init });
      const handler = slack[url.replace("https://slack.com/api/", "")];
      if (!handler) throw new Error(`unexpected Slack call ${url}`);
      return handler();
    },
  );
  const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  env = { DB: database.db, SLACK_CLIENT_ID: "synthetic-client", SLACK_CLIENT_SECRET: SECRET, SLACK_TOKEN_KEY: key } as Bindings;
});
afterEach(() => database.sqlite.close());

const get = (path: string, cookie?: string) => app.request(`${ORIGIN}/v1${path}`, { headers: cookie ? { Cookie: cookie } : {} }, env);
async function login(email: string) {
  const request = await app.request(`${ORIGIN}/v1/auth/otp/request`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ email }),
  }, env);
  const { challengeId } = await request.json() as { challengeId: string };
  const verify = await app.request(`${ORIGIN}/v1/auth/otp/verify`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ challengeId, code: codes.at(-1) }),
  }, env);
  clock += authPolicy.resendCooldownMs;
  return verify.headers.get("Set-Cookie")!.split(";")[0]!;
}
async function startInstall(cookie: string) {
  const response = await get("/slack/install", cookie);
  expect(response.status).toBe(302);
  return new URL(response.headers.get("Location")!).searchParams.get("state")!;
}
async function callback(cookie: string | undefined, query: Record<string, string>) {
  const response = await get(`/slack/oauth/callback?${new URLSearchParams(query)}`, cookie);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location")!);
  expect(location.origin + location.pathname).toBe(`${ORIGIN}/workspace`);
  return location.searchParams.get("slack");
}
const connection = async (cookie: string) => slackConnectionSchema.parse(await (await get("/slack/connection", cookie)).json());
const installation = () => database.sqlite.query("SELECT * FROM slack_installations").get() as Record<string, unknown> | null;
const auditRows = () => database.sqlite.query("SELECT action, target_type, result FROM audit_events WHERE action = 'slack.install'").all();
const oauthCalls = () => calls.filter(call => call.url.endsWith("oauth.v2.access")).length;

test("install redirects to Slack with the manifest scopes, our callback and a hashed single-use state", async () => {
  expect([...manifest.oauth_config.scopes.bot].sort()).toEqual([...slackBotScopes].sort());
  expect(manifest.oauth_config.redirect_urls).toEqual([`${ORIGIN}/v1/slack/oauth/callback`]);

  expect((await get("/slack/install")).status).toBe(401);
  const cookie = await login(profA!.email);
  const response = await get("/slack/install", cookie);
  const target = new URL(response.headers.get("Location")!);
  expect(target.origin + target.pathname).toBe("https://slack.com/oauth/v2/authorize");
  expect(target.searchParams.get("scope")).toBe(ALL_SCOPES);
  expect(target.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/v1/slack/oauth/callback`);
  const state = target.searchParams.get("state")!;
  expect(JSON.stringify(database.sqlite.query("SELECT * FROM slack_oauth_states").all())).not.toContain(state);

  delete env.SLACK_CLIENT_SECRET;
  const unconfigured = await get("/slack/install", cookie);
  expect(apiErrorSchema.parse(await unconfigured.json()).error.code).toBe("SLACK_UNAVAILABLE");
});

test("install stores only a sealed token, reports connected without secrets, and reinstall replaces the token", async () => {
  const cookie = await login(profA!.email);
  expect(await callback(cookie, { state: await startInstall(cookie), code: "synthetic-code" })).toBe("installed");

  const exchange = calls.find(call => call.url.endsWith("oauth.v2.access"))!;
  expect(String(exchange.init.body)).toContain("redirect_uri=");
  expect(String(exchange.init.body)).not.toContain(SECRET); // client secret goes in Basic auth, never the body
  const row = installation()!;
  expect(JSON.stringify(row)).not.toContain(BOT_TOKEN);
  expect(await openToken(env.SLACK_TOKEN_KEY!, String(row.workspace_id), String(row.token_ciphertext))).toBe(BOT_TOKEN);
  await expect(openToken(env.SLACK_TOKEN_KEY!, "workspace_other", String(row.token_ciphertext))).rejects.toThrow();

  const raw = await (await get("/slack/connection", cookie)).text();
  expect(raw).not.toContain("xoxb");
  expect(JSON.parse(raw)).toEqual({
    status: "connected", missingScopes: [],
    workspace: { id: row.workspace_id, slackTeamId: TEAM.id, name: TEAM.name, installedAt: new Date(Number(row.installed_at)).toISOString() },
  });
  // Checking the connection reads no messages, files or members.
  expect(calls.map(call => call.url.replace("https://slack.com/api/", ""))).toEqual(["oauth.v2.access", "auth.test"]);

  // Another professor may reinstall the same pilot workspace; the row is replaced, not duplicated.
  const cookieB = await login(profB!.email);
  expect(await callback(cookieB, { state: await startInstall(cookieB), code: "synthetic-code-2" })).toBe("reinstalled");
  expect(database.sqlite.query("SELECT COUNT(*) AS n FROM slack_installations").get()).toEqual({ n: 1 });
  expect(installation()!.installed_by_professor_id).toBe(profB!.id);
  expect(auditRows()).toEqual([
    { action: "slack.install", target_type: "workspace", result: "succeeded" },
    { action: "slack.install", target_type: "workspace", result: "succeeded" },
  ]);
});

test("state is single use, expires, and only works for the session that started the install", async () => {
  const cookieA = await login(profA!.email);
  const cookieB = await login(profB!.email);

  const stolen = await startInstall(cookieA);
  expect(await callback(cookieB, { state: stolen, code: "c" })).toBe("invalid_state");
  expect(await callback(undefined, { state: stolen, code: "c" })).toBe("invalid_state");
  expect(await callback(cookieA, { state: "forged", code: "c" })).toBe("invalid_state");
  expect(await callback(cookieA, { code: "c" })).toBe("invalid_state");

  expect(await callback(cookieA, { state: stolen, code: "c" })).toBe("installed");
  expect(await callback(cookieA, { state: stolen, code: "c" })).toBe("invalid_state");

  const late = await startInstall(cookieA);
  clock += 10 * 60_000;
  expect(await callback(cookieA, { state: late, code: "c" })).toBe("invalid_state");
  expect(oauthCalls()).toBe(1);
});

test("cancel, failed exchange and outages never store a token", async () => {
  const cookie = await login(profA!.email);
  expect(await callback(cookie, { state: await startInstall(cookie), error: "access_denied" })).toBe("cancelled");
  expect(oauthCalls()).toBe(0);

  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    slack["oauth.v2.access"] = () => json({ ok: false, error: "invalid_code" });
    expect(await callback(cookie, { state: await startInstall(cookie), code: "synthetic-code" })).toBe("failed");
    slack["oauth.v2.access"] = () => json({ ok: true, access_token: "xoxp-user-token", token_type: "user" });
    expect(await callback(cookie, { state: await startInstall(cookie), code: "synthetic-code" })).toBe("failed");
    slack["oauth.v2.access"] = () => { throw new Error("network down"); };
    expect(await callback(cookie, { state: await startInstall(cookie), code: "synthetic-code" })).toBe("failed");
    const logged = JSON.stringify(errors.mock.calls);
    for (const secret of ["synthetic-code", SECRET, "xoxp-user-token"]) expect(logged).not.toContain(secret);
  } finally {
    errors.mockRestore();
  }
  expect(installation()).toBeNull();
  expect(database.sqlite.query("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 0 });
});

test("a second Slack workspace never replaces the pilot workspace", async () => {
  const cookie = await login(profA!.email);
  await callback(cookie, { state: await startInstall(cookie), code: "c" });
  const before = installation();

  slack["oauth.v2.access"] = () => grant(OTHER_TEAM);
  expect(await callback(cookie, { state: await startInstall(cookie), code: "c" })).toBe("workspace_mismatch");
  expect(installation()).toEqual(before);
  expect(database.sqlite.query("SELECT slack_team_id FROM workspaces").all()).toEqual([{ slack_team_id: TEAM.id }]);
  expect(auditRows().at(-1)).toEqual({ action: "slack.install", target_type: "workspace", result: "denied" });
});

test("connection reports not connected, missing scopes, revocation and Slack outages", async () => {
  const cookie = await login(profA!.email);
  expect(await connection(cookie)).toEqual({ status: "not_connected", workspace: null, missingScopes: [] });
  expect((await get("/slack/connection")).status).toBe(401);

  slack["oauth.v2.access"] = () => grant(TEAM, "channels:history,channels:read");
  expect(await callback(cookie, { state: await startInstall(cookie), code: "c" })).toBe("insufficient_scope");
  slack["auth.test"] = () => json({ ok: true }, { "x-oauth-scopes": "channels:history,channels:read" });
  const partial = await connection(cookie);
  expect(partial.status).toBe("insufficient_scope");
  expect(partial.missingScopes).toEqual(["channels:join", "channels:manage", "files:read", "users:read"]);

  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    slack["auth.test"] = () => json({ ok: false, error: "ratelimited" });
    const outage = await get("/slack/connection", cookie);
    expect(outage.status).toBe(503);
    expect(apiErrorSchema.parse(await outage.json()).error.retryable).toBe(true);
    expect(installation()!.token_ciphertext).not.toBeNull(); // an outage is not a revocation
  } finally {
    errors.mockRestore();
  }

  slack["auth.test"] = () => json({ ok: false, error: "token_revoked" });
  expect((await connection(cookie)).status).toBe("revoked");
  expect(installation()!.token_ciphertext).toBeNull();
  const checks = calls.filter(call => call.url.endsWith("auth.test")).length;
  expect((await connection(cookie)).status).toBe("revoked");
  expect(calls.filter(call => call.url.endsWith("auth.test")).length).toBe(checks); // no token left to send

  // Reinstalling after a revoke restores the connection.
  slack["oauth.v2.access"] = () => grant();
  slack["auth.test"] = () => json({ ok: true }, { "x-oauth-scopes": ALL_SCOPES });
  expect(await callback(cookie, { state: await startInstall(cookie), code: "c" })).toBe("reinstalled");
  expect((await connection(cookie)).status).toBe("connected");
});

test("sealed tokens need the same key and workspace", async () => {
  const key = env.SLACK_TOKEN_KEY!;
  const sealed = await sealToken(key, "workspace_a", BOT_TOKEN);
  expect(sealed).not.toContain(BOT_TOKEN);
  expect(await openToken(key, "workspace_a", sealed)).toBe(BOT_TOKEN);
  const otherKey = btoa(String.fromCharCode(...new Uint8Array(32)));
  await expect(openToken(otherKey, "workspace_a", sealed)).rejects.toThrow();
  await expect(sealToken(btoa("short"), "workspace_a", BOT_TOKEN)).rejects.toThrow("SLACK_TOKEN_KEY_INVALID");
});
