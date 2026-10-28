import { Hono, type Context } from "hono";
import {
  slackTeamIdSchema, slackUserIdSchema, type SlackConnection, type SlackInstallOutcome,
} from "@teamplanet/contracts";
import { encoder, iso, randomToken, sessionProfessor, sessionToken, sha256 } from "./auth";
import { apiError } from "./errors";
import { audit, type ProtectedEnv } from "./guard";

/**
 * Bot scopes checked against docs.slack.dev on 2026-10-28, public channels only:
 * conversations.create/invite (channels:manage), .join (channels:join), .info/.members (channels:read),
 * .history/.replies + message.channels events (channels:history), files.info (files:read), users.info (users:read).
 * Keep in sync with apps/api/slack-manifest.json (a test compares them).
 */
export const slackBotScopes = [
  "channels:history", "channels:join", "channels:manage", "channels:read", "files:read", "users:read",
] as const;
export type SlackBindings = { SLACK_CLIENT_ID?: string; SLACK_CLIENT_SECRET?: string; SLACK_TOKEN_KEY?: string };
export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;
export type SlackEnv = { Bindings: ProtectedEnv["Bindings"] & SlackBindings; Variables: ProtectedEnv["Variables"] };
type Env = SlackEnv;

const STATE_TTL_MS = 10 * 60_000;
// Errors meaning our stored bot token no longer works: the app was uninstalled or the token revoked.
const revokedErrors = new Set(["token_revoked", "invalid_auth", "account_inactive", "token_expired", "not_authed"]);

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function tokenKey(secret: string) {
  const raw = fromBase64(secret);
  if (raw.length !== 32) throw new Error("SLACK_TOKEN_KEY_INVALID");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** AES-GCM with the workspace ID as associated data, so a sealed token only opens for its own row. */
export async function sealToken(secret: string, workspaceId: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(workspaceId) }, await tokenKey(secret), encoder.encode(token),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}
export async function openToken(secret: string, workspaceId: string, sealed: string) {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("SLACK_TOKEN_FORMAT");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(workspaceId) }, await tokenKey(secret), fromBase64(data),
  );
  return new TextDecoder().decode(plain);
}

const missingScopes = (granted: string | null | undefined) => {
  const have = new Set((granted ?? "").split(",").map(scope => scope.trim()));
  return slackBotScopes.filter(scope => !have.has(scope));
};
// Slack error codes are short snake_case identifiers; log nothing else from Slack responses.
const slackErrorCode = (body: unknown) => {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown";
};

type Grant = { token: string; scope: string; botUserId: string; appId: string; teamId: string; teamName: string; installerId: string };
function parseGrant(body: unknown): Grant | null {
  // Untrusted JSON: every field used below is checked before it is trusted.
  const b = body as Record<string, any> | null;
  if (!b || b.ok !== true || b.token_type !== "bot" || b.is_enterprise_install === true) return null;
  if (typeof b.access_token !== "string" || !b.access_token.startsWith("xoxb-") || typeof b.app_id !== "string") return null;
  if (!slackTeamIdSchema.safeParse(b.team?.id).success || typeof b.team?.name !== "string" || !b.team.name.trim()) return null;
  if (!slackUserIdSchema.safeParse(b.bot_user_id).success || !slackUserIdSchema.safeParse(b.authed_user?.id).success) return null;
  return {
    token: b.access_token, scope: typeof b.scope === "string" ? b.scope : "", botUserId: b.bot_user_id, appId: b.app_id,
    teamId: b.team.id, teamName: b.team.name.trim().slice(0, 200), installerId: b.authed_user.id,
  };
}

type InstallationRow = { id: string; slack_team_id: string; team_name: string; scopes: string; token_ciphertext: string | null; installed_at: number };

export function slackRoutes(now: () => number, send: SlackFetch) {
  const routes = new Hono<Env>();
  // The web app forwards /v1/* with the original URL, so this is the public callback registered in the manifest.
  const callbackUrl = (context: Context<Env>) => new URL("/v1/slack/oauth/callback", context.req.url).toString();
  const back = (context: Context<Env>, outcome: SlackInstallOutcome) =>
    context.redirect(new URL(`/workspace?slack=${outcome}`, context.req.url).toString(), 302);

  routes.get("/slack/install", async context => {
    const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: secret, SLACK_TOKEN_KEY: key } = context.env;
    if (!clientId || !secret || !key) return apiError(context, "SLACK_UNAVAILABLE", "Slack 연결이 설정되지 않았습니다.");
    const db = context.env.DB;
    const state = randomToken();
    const at = now();
    await db.batch([
      db.prepare("DELETE FROM slack_oauth_states WHERE expires_at <= ?").bind(at),
      db.prepare("INSERT INTO slack_oauth_states (state_hash, session_hash, professor_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .bind(await sha256(state), await sha256(sessionToken(context)!), context.get("professor").id, at, at + STATE_TTL_MS),
    ]);
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.search = new URLSearchParams({
      client_id: clientId, scope: slackBotScopes.join(","), redirect_uri: callbackUrl(context), state,
    }).toString();
    return context.redirect(authorize.toString(), 302);
  });

  // Self-authenticated (see guard.ts): the state must be unused, unexpired and minted for this very session.
  routes.get("/slack/oauth/callback", async context => {
    const db = context.env.DB;
    const at = now();
    const { state, code, error } = context.req.query();
    const token = sessionToken(context);
    const session = await sessionProfessor(db, token, at);
    if (!state || !token || !session) return back(context, "invalid_state");
    const consumed = await db.prepare(`UPDATE slack_oauth_states SET consumed_at = ?
      WHERE state_hash = ? AND session_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING professor_id`)
      .bind(at, await sha256(state), await sha256(token), at).first();
    if (!consumed) return back(context, "invalid_state");
    context.set("professor", session.professor);
    if (error || !code) return back(context, "cancelled"); // Slack sends error=access_denied when the installer cancels.

    const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: secret, SLACK_TOKEN_KEY: key } = context.env;
    if (!clientId || !secret || !key) return back(context, "failed");
    let grant: Grant | null = null;
    try {
      const response = await send("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, redirect_uri: callbackUrl(context) }).toString(),
      });
      const body = await response.json().catch(() => null);
      grant = response.ok ? parseGrant(body) : null;
      if (!grant) console.error("slack.oauth_exchange_failed", slackErrorCode(body));
    } catch {
      console.error("slack.oauth_exchange_failed", "network");
    }
    if (!grant) return back(context, "failed");

    // The pilot has exactly one workspace (unique index); a different Slack team never silently replaces it.
    await db.prepare("INSERT INTO workspaces (id, slack_team_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(`workspace_${crypto.randomUUID()}`, grant.teamId, at).run();
    const workspace = await db.prepare("SELECT id FROM workspaces WHERE slack_team_id = ?").bind(grant.teamId).first<{ id: string }>();
    if (!workspace) {
      const current = (await db.prepare("SELECT id FROM workspaces LIMIT 1").first<{ id: string }>())!;
      await audit(context, { action: "slack.install", targetType: "workspace", targetId: current.id, result: "denied" }, now).run();
      return back(context, "workspace_mismatch");
    }
    const previous = await db.prepare("SELECT 1 FROM slack_installations WHERE workspace_id = ?").bind(workspace.id).first();
    await db.batch([
      db.prepare(`INSERT INTO slack_installations (workspace_id, team_name, app_id, bot_user_id, scopes, token_ciphertext,
          installed_by_slack_user_id, installed_by_professor_id, installed_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT (workspace_id) DO UPDATE SET team_name = excluded.team_name, app_id = excluded.app_id,
          bot_user_id = excluded.bot_user_id, scopes = excluded.scopes, token_ciphertext = excluded.token_ciphertext,
          installed_by_slack_user_id = excluded.installed_by_slack_user_id,
          installed_by_professor_id = excluded.installed_by_professor_id, installed_at = excluded.installed_at, revoked_at = NULL`)
        .bind(workspace.id, grant.teamName, grant.appId, grant.botUserId, grant.scope, await sealToken(key, workspace.id, grant.token),
          grant.installerId, session.professor.id, at),
      audit(context, { action: "slack.install", targetType: "workspace", targetId: workspace.id, result: "succeeded" }, now),
    ]);
    if (missingScopes(grant.scope).length) return back(context, "insufficient_scope");
    return back(context, previous ? "reinstalled" : "installed");
  });

  // Live check with auth.test only: it reads no messages or files, so it never backfills before consent.
  routes.get("/slack/connection", async context => {
    const db = context.env.DB;
    const row = await db.prepare(`SELECT w.id, w.slack_team_id, i.team_name, i.scopes, i.token_ciphertext, i.installed_at
      FROM slack_installations i JOIN workspaces w ON w.id = i.workspace_id`).first<InstallationRow>();
    if (!row) return context.json({ status: "not_connected", workspace: null, missingScopes: [] } satisfies SlackConnection, 200);
    const workspace = { id: row.id, slackTeamId: row.slack_team_id, name: row.team_name, installedAt: iso(row.installed_at) };
    if (!row.token_ciphertext) return context.json({ status: "revoked", workspace, missingScopes: [] } satisfies SlackConnection, 200);
    const unavailable = () => apiError(context, "SLACK_UNAVAILABLE", "Slack 연결 상태를 확인하지 못했습니다.", { retryable: true });
    const key = context.env.SLACK_TOKEN_KEY;
    if (!key) return unavailable();

    let response: Response;
    try {
      const token = await openToken(key, row.id, row.token_ciphertext);
      response = await send("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } catch {
      console.error("slack.connection_check_failed", "network_or_key");
      return unavailable();
    }
    const body = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (body?.ok !== true) {
      const code = slackErrorCode(body);
      if (!revokedErrors.has(code)) {
        console.error("slack.connection_check_failed", code);
        return unavailable();
      }
      await db.prepare("UPDATE slack_installations SET token_ciphertext = NULL, revoked_at = ? WHERE workspace_id = ?").bind(now(), row.id).run();
      return context.json({ status: "revoked", workspace, missingScopes: [] } satisfies SlackConnection, 200);
    }
    // Slack reports the token's current scopes on every Web API response.
    const missing = missingScopes(response.headers.get("x-oauth-scopes") ?? row.scopes);
    return context.json({ status: missing.length ? "insufficient_scope" : "connected", workspace, missingScopes: missing } satisfies SlackConnection, 200);
  });

  return routes;
}

export type SlackBot = { workspaceId: string; slackTeamId: string; botUserId: string; token: string };
/** The live bot of the pilot workspace, or null when Slack is not connected, revoked or the key is missing. */
export async function slackBot(context: Context<SlackEnv>): Promise<SlackBot | null> {
  const key = context.env.SLACK_TOKEN_KEY;
  const row = await context.env.DB.prepare(`SELECT w.id, w.slack_team_id, i.bot_user_id, i.token_ciphertext
    FROM slack_installations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_ciphertext IS NOT NULL`)
    .first<{ id: string; slack_team_id: string; bot_user_id: string; token_ciphertext: string }>();
  if (!row || !key) return null;
  return { workspaceId: row.id, slackTeamId: row.slack_team_id, botUserId: row.bot_user_id, token: await openToken(key, row.id, row.token_ciphertext) };
}

// Untrusted Slack JSON; route code checks every field it uses.
export type SlackResult = { ok: true; body: Record<string, any> } | { ok: false; error: string; retryAfter?: number };
/** One Web API call with the bot token. Throws only on network failure. */
export async function callSlack(send: SlackFetch, token: string, method: string, params: Record<string, string>): Promise<SlackResult> {
  const response = await send(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.ok === true) return { ok: true, body };
  const retryAfter = Number(response.headers.get("Retry-After"));
  return { ok: false, error: response.status === 429 ? "ratelimited" : slackErrorCode(body), ...(retryAfter > 0 ? { retryAfter } : {}) };
}
/** Common answer for a Slack failure the route does not handle itself. Never echoes Slack bodies. */
export function slackFailure(context: Context, method: string, result: { error: string; retryAfter?: number }) {
  if (result.error === "ratelimited") {
    return apiError(context, "RATE_LIMITED", "Slack 요청이 많습니다. 잠시 후 다시 시도하세요.", { retryable: true, retryAfterSeconds: result.retryAfter ?? 30 });
  }
  console.error("slack.call_failed", method, result.error);
  if (revokedErrors.has(result.error)) return apiError(context, "SLACK_UNAVAILABLE", "Slack 연결을 다시 확인하세요.");
  return apiError(context, "SLACK_UNAVAILABLE", "Slack 요청을 처리하지 못했습니다.", { retryable: true });
}
export const slackNotConnected = (context: Context) => apiError(context, "SLACK_UNAVAILABLE", "Slack을 먼저 연결하세요.");
