import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { D1Database } from "@cloudflare/workers-types";
import { otpRequestSchema, otpVerifySchema, type Professor } from "@teamplanet/contracts";
import { apiError, parseBody } from "./errors";
import { defaultMailer, type MailBindings, type Mailer } from "./mailer";

/** Operating defaults decided in #2. Fixture values in @teamplanet/contracts are not policy. */
export const authPolicy = {
  otpTtlMs: 5 * 60_000,
  resendCooldownMs: 60_000,
  maxRequestsPerHour: 5,
  maxVerifyAttempts: 5,
  sessionTtlMs: 8 * 60 * 60_000,
  // Every accepted OTP request takes at least this long, hiding provider latency for registered emails.
  minRequestMs: 1_000,
  // Challenge rows hold typed emails (also unregistered ones); keep them only past the rate-limit window.
  challengeRetentionMs: 24 * 60 * 60_000,
};
export type AuthPolicy = typeof authPolicy;
export type AuthDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  policy: AuthPolicy;
  mailer: (env: MailBindings, url: URL) => Mailer;
};
export const defaultAuthDeps: AuthDeps = {
  now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), policy: authPolicy, mailer: defaultMailer,
};

type Env = { Bindings: { DB: D1Database } & MailBindings };
const COOKIE = "teamplanet_session"; // sent as __Host-teamplanet_session via prefix "host"
const HOUR_MS = 60 * 60_000;

export const encoder = new TextEncoder();
export async function sha256(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
function randomCode() {
  const value = new Uint32Array(1);
  // Rejection sampling keeps all 1,000,000 codes equally likely.
  do crypto.getRandomValues(value); while (value[0]! >= 4_294_000_000);
  return String(value[0]! % 1_000_000).padStart(6, "0");
}
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export const iso = (ms: number) => new Date(ms).toISOString();


type SessionRow = { id: string; email: string; created_at: number; expires_at: number };
/** Resolves the professor for a session token; #3 builds its ownership guard on this. */
export async function sessionProfessor(db: D1Database, token: string | undefined, now: number) {
  if (!token) return null;
  const row = await db.prepare(`SELECT p.id, p.email, p.created_at, s.expires_at FROM auth_sessions s
    JOIN professors p ON p.id = s.professor_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).bind(await sha256(token), now).first<SessionRow>();
  if (!row) return null;
  const professor: Professor = { id: row.id, email: row.email, createdAt: iso(row.created_at) };
  return { professor, expiresAt: iso(row.expires_at) };
}
export const sessionToken = (context: Context) => getCookie(context, COOKIE, "host");

export function authRoutes(deps: AuthDeps = defaultAuthDeps) {
  const { policy } = deps;
  const routes = new Hono<Env>();

  routes.post("/otp/request", async context => {
    const input = await parseBody(context, otpRequestSchema);
    if (input.error) return input.error;
    const [response] = await Promise.all([requestOtp(context, input.data.email), deps.sleep(policy.minRequestMs)]);
    return response;
  });

  async function requestOtp(context: Context<Env>, email: string) {
    const db = context.env.DB;
    const now = deps.now();
    await db.prepare("DELETE FROM auth_challenges WHERE created_at < ?").bind(now - policy.challengeRetentionMs).run();
    const professor = await db.prepare("SELECT id FROM professors WHERE email = ?").bind(email).first<{ id: string }>();
    const challengeId = `challenge_${crypto.randomUUID()}`;
    const code = randomCode();
    // Registered or not, the same row is written under the same atomic cooldown/hourly limit.
    const inserted = await db.prepare(`INSERT INTO auth_challenges (id, email, professor_id, code_hash, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM auth_challenges WHERE email = ? AND created_at > ?)
      AND (SELECT COUNT(*) FROM auth_challenges WHERE email = ? AND created_at > ?) < ?`).bind(
      challengeId, email, professor?.id ?? null, await sha256(`${challengeId}:${code}`), now, now + policy.otpTtlMs,
      email, now - policy.resendCooldownMs, email, now - HOUR_MS, policy.maxRequestsPerHour,
    ).run();
    if (!inserted.meta.changes) {
      const recent = (await db.prepare(`SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS latest
        FROM auth_challenges WHERE email = ? AND created_at > ?`).bind(email, now - HOUR_MS).first<{ count: number; oldest: number; latest: number }>())!;
      const retryAt = Math.max(recent.latest + policy.resendCooldownMs, recent.count >= policy.maxRequestsPerHour ? recent.oldest + HOUR_MS : 0);
      return apiError(context, "RATE_LIMITED", "잠시 후 다시 시도하세요.", {
        retryable: true, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      });
    }
    if (professor) {
      try {
        await deps.mailer(context.env, new URL(context.req.url))({ to: email, code, challengeId, expiresAt: new Date(now + policy.otpTtlMs) });
      } catch (error) {
        // Remove the undelivered challenge so the professor can retry without waiting for the cooldown.
        await db.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(challengeId).run();
        console.error("auth.email_delivery_failed", error instanceof Error ? error.message : "unknown");
        return apiError(context, "EMAIL_DELIVERY_UNAVAILABLE", "인증 메일을 발송하지 못했습니다.", { retryable: true });
      }
    }
    return context.json({ challengeId, expiresAt: iso(now + policy.otpTtlMs), resendAvailableAt: iso(now + policy.resendCooldownMs) }, 202);
  }

  routes.post("/otp/verify", async context => {
    const input = await parseBody(context, otpVerifySchema);
    if (input.error) return input.error;
    const { challengeId, code } = input.data;
    const db = context.env.DB;
    const now = deps.now();
    const invalid = () => apiError(context, "OTP_INVALID", "인증 코드가 유효하지 않습니다.");
    const challenge = await db.prepare("SELECT code_hash, attempts, expires_at, consumed_at FROM auth_challenges WHERE id = ?")
      .bind(challengeId).first<{ code_hash: string; attempts: number; expires_at: number; consumed_at: number | null }>();
    if (!challenge || challenge.consumed_at !== null) return invalid();
    if (now >= challenge.expires_at) return apiError(context, "OTP_EXPIRED", "인증 코드가 만료되었습니다.");
    if (challenge.attempts >= policy.maxVerifyAttempts) return apiError(context, "RATE_LIMITED", "새 인증 코드를 요청하세요.");
    const counted = await db.prepare("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ? RETURNING attempts")
      .bind(challengeId, policy.maxVerifyAttempts).first();
    if (!counted || await sha256(`${challengeId}:${code}`) !== challenge.code_hash) return invalid();
    // Single use: only one concurrent verifier can flip consumed_at.
    const consumed = await db.prepare(`UPDATE auth_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND professor_id IS NOT NULL RETURNING professor_id`)
      .bind(now, challengeId).first<{ professor_id: string }>();
    if (!consumed) return invalid();

    const previous = sessionToken(context);
    if (previous) await db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now, await sha256(previous)).run();
    await db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now).run();
    const token = randomToken();
    const expiresAt = now + policy.sessionTtlMs;
    await db.prepare("INSERT INTO auth_sessions (token_hash, professor_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), consumed.professor_id, now, expiresAt).run();
    setCookie(context, COOKIE, token, {
      prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: new Date(expiresAt),
    });
    return context.json((await sessionProfessor(db, token, now))!, 200);
  });

  routes.get("/me", async context => {
    const session = await sessionProfessor(context.env.DB, sessionToken(context), deps.now());
    return session ? context.json(session, 200) : apiError(context, "UNAUTHENTICATED", "로그인이 필요합니다.");
  });

  routes.post("/logout", async context => {
    const token = sessionToken(context);
    if (token) {
      await context.env.DB.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
        .bind(deps.now(), await sha256(token)).run();
    }
    deleteCookie(context, COOKIE, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    return context.json({ loggedOut: true as const }, 200);
  });

  return routes;
}
