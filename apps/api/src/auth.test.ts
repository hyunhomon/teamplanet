import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  apiErrorSchema, logoutResponseSchema, otpRequestResponseSchema, sessionResponseSchema,
} from "@teamplanet/contracts";
import { professors } from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "../../../tests/helpers/d1";
import { authPolicy } from "./auth";
import { createApp, type Bindings } from "./index";
import { defaultMailer, resendMailer, type OtpMail } from "./mailer";

const ORIGIN = "https://teamplanet.cloby.co";
const professor = professors[0]!;
let clock: number;
let database: ReturnType<typeof sqliteD1>;
let sent: OtpMail[];
let mailFails: boolean;
let app: ReturnType<typeof createApp>;
let env: Bindings;

beforeEach(() => {
  clock = Date.parse("2026-10-27T00:00:00.000Z");
  database = sqliteD1();
  database.sqlite.run("INSERT INTO professors (id, email, created_at) VALUES (?, ?, ?)", [professor.id, professor.email, Date.parse(professor.createdAt)]);
  sent = [];
  mailFails = false;
  app = createApp({
    now: () => clock, sleep: async () => {}, policy: authPolicy,
    mailer: () => async mail => { if (mailFails) throw new Error("EMAIL_PROVIDER_STATUS_500"); sent.push(mail); },
  });
  env = { DB: database.db } as Bindings;
});
afterEach(() => database.sqlite.close());

function call(path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
  if (init.cookie) headers.Cookie = init.cookie;
  return app.request(`${ORIGIN}/v1/auth${path}`, {
    method: init.method ?? "POST", headers,
    body: typeof init.body === "string" ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body),
  }, env);
}
const requestOtp = (email = professor.email) => call("/otp/request", { body: { email } });
async function errorCode(response: Response) { return apiErrorSchema.parse(await response.json()).error.code; }
async function login() {
  const accepted = otpRequestResponseSchema.parse(await (await requestOtp()).json());
  const response = await call("/otp/verify", { body: { challengeId: accepted.challengeId, code: sent.at(-1)!.code } });
  const cookie = response.headers.get("Set-Cookie")!.split(";")[0]!;
  return { response, cookie };
}

test("OTP login issues a hardened session cookie that /me and logout honour", async () => {
  const { response, cookie } = await login();
  expect(response.status).toBe(200);
  expect(sessionResponseSchema.parse(await response.json())).toEqual({
    professor, expiresAt: new Date(clock + authPolicy.sessionTtlMs).toISOString(),
  });
  const setCookie = response.headers.get("Set-Cookie")!;
  expect(setCookie).toStartWith("__Host-teamplanet_session=");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(setCookie).toContain(flag);
  expect(setCookie).not.toContain("Domain");
  expect(response.headers.get("Cache-Control")).toBe("no-store");

  const me = await call("/me", { method: "GET", cookie });
  expect(sessionResponseSchema.parse(await me.json()).professor).toEqual(professor);

  const logout = await call("/logout", { cookie });
  expect(logoutResponseSchema.parse(await logout.json())).toEqual({ loggedOut: true });
  expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
  expect(await errorCode(await call("/me", { method: "GET", cookie }))).toBe("UNAUTHENTICATED");
  expect((await call("/logout", { cookie })).status).toBe(200);
  expect((await call("/logout")).status).toBe(200);
});

test("only hashes of OTP codes and session tokens are stored", async () => {
  const { cookie } = await login();
  const stored = JSON.stringify(database.sqlite.query("SELECT * FROM auth_challenges, auth_sessions").all());
  expect(stored).not.toContain(sent[0]!.code);
  expect(stored).not.toContain(cookie.split("=")[1]!);
});

test("registered and unregistered emails get the same response shape and no mail goes to strangers", async () => {
  const registered = await requestOtp("PROFESSOR-A@example.invalid");
  const stranger = await requestOtp("nobody@example.invalid");
  expect(registered.status).toBe(202);
  expect(stranger.status).toBe(202);
  otpRequestResponseSchema.parse(await registered.json());
  const { challengeId } = otpRequestResponseSchema.parse(await stranger.json());
  expect(sent.map(mail => mail.to)).toEqual([professor.email]);
  for (const code of ["000000", "123456"]) {
    expect(await errorCode(await call("/otp/verify", { body: { challengeId, code } }))).toBe("OTP_INVALID");
  }
  // Repeated requests for unregistered emails are throttled exactly like registered ones.
  expect(await errorCode(await requestOtp("nobody@example.invalid"))).toBe("RATE_LIMITED");
});

test("expired, reused and wrong codes fail; attempts are capped per challenge", async () => {
  const first = otpRequestResponseSchema.parse(await (await requestOtp()).json());
  const code = sent[0]!.code;
  const wrong = code === "000000" ? "000001" : "000000";
  for (let attempt = 0; attempt < authPolicy.maxVerifyAttempts; attempt++) {
    expect(await errorCode(await call("/otp/verify", { body: { challengeId: first.challengeId, code: wrong } }))).toBe("OTP_INVALID");
  }
  expect(await errorCode(await call("/otp/verify", { body: { challengeId: first.challengeId, code } }))).toBe("RATE_LIMITED");

  clock += authPolicy.resendCooldownMs;
  const second = otpRequestResponseSchema.parse(await (await requestOtp()).json());
  expect((await call("/otp/verify", { body: { challengeId: second.challengeId, code: sent[1]!.code } })).status).toBe(200);
  expect(await errorCode(await call("/otp/verify", { body: { challengeId: second.challengeId, code: sent[1]!.code } }))).toBe("OTP_INVALID");

  clock += authPolicy.resendCooldownMs;
  const third = otpRequestResponseSchema.parse(await (await requestOtp()).json());
  clock += authPolicy.otpTtlMs;
  expect(await errorCode(await call("/otp/verify", { body: { challengeId: third.challengeId, code: sent[2]!.code } }))).toBe("OTP_EXPIRED");
});

test("concurrent verification of one code yields exactly one session", async () => {
  const { challengeId } = otpRequestResponseSchema.parse(await (await requestOtp()).json());
  const body = { challengeId, code: sent[0]!.code };
  const results = await Promise.all([call("/otp/verify", { body }), call("/otp/verify", { body }), call("/otp/verify", { body })]);
  expect(results.map(response => response.status).sort()).toEqual([200, 401, 401]);
  expect(database.sqlite.query("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
});

test("resend cooldown and hourly limit return 429 with Retry-After", async () => {
  expect((await requestOtp()).status).toBe(202);
  const tooSoon = await requestOtp();
  expect(tooSoon.status).toBe(429);
  expect(tooSoon.headers.get("Retry-After")).toBe("60");
  expect(apiErrorSchema.parse(await tooSoon.json()).error).toMatchObject({ retryable: true, retryAfterSeconds: 60 });
  for (let request = 1; request < authPolicy.maxRequestsPerHour; request++) {
    clock += authPolicy.resendCooldownMs;
    expect((await requestOtp()).status).toBe(202);
  }
  clock += authPolicy.resendCooldownMs;
  const hourly = await requestOtp();
  expect(hourly.status).toBe(429);
  expect(Number(hourly.headers.get("Retry-After"))).toBe(60 * 60 - authPolicy.maxRequestsPerHour * 60);
});

test("provider failure is reported, never faked, and leaves no usable challenge or secret in logs", async () => {
  const logs: string[] = [];
  const spies = [spyOn(console, "log"), spyOn(console, "error")].map(spy => spy.mockImplementation((...args) => { logs.push(args.join(" ")); }));
  mailFails = true;
  const failed = await requestOtp();
  expect(failed.status).toBe(503);
  expect(apiErrorSchema.parse(await failed.json()).error).toMatchObject({ code: "EMAIL_DELIVERY_UNAVAILABLE", retryable: true });
  expect(database.sqlite.query("SELECT COUNT(*) AS count FROM auth_challenges").get()).toEqual({ count: 0 });

  mailFails = false;
  const { cookie } = await login();
  spies.forEach(spy => spy.mockRestore());
  expect(logs).toEqual(["auth.email_delivery_failed EMAIL_PROVIDER_STATUS_500"]);
  expect(logs.join()).not.toContain(sent[0]!.code);
  expect(logs.join()).not.toContain(cookie.split("=")[1]!);
});

test("state-changing requests from another or missing origin are rejected before any write", async () => {
  for (const origin of ["https://evil.example", null]) {
    const response = await call("/otp/request", { body: { email: professor.email }, origin });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  }
  expect(sent).toEqual([]);
  expect(database.sqlite.query("SELECT COUNT(*) AS count FROM auth_challenges").get()).toEqual({ count: 0 });
});

test("sessions expire, and a new login revokes the session cookie it replaces", async () => {
  const first = await login();
  clock += authPolicy.resendCooldownMs;
  const accepted = otpRequestResponseSchema.parse(await (await requestOtp()).json());
  const second = await call("/otp/verify", { body: { challengeId: accepted.challengeId, code: sent[1]!.code }, cookie: first.cookie });
  const secondCookie = second.headers.get("Set-Cookie")!.split(";")[0]!;
  expect(await errorCode(await call("/me", { method: "GET", cookie: first.cookie }))).toBe("UNAUTHENTICATED");
  expect((await call("/me", { method: "GET", cookie: secondCookie })).status).toBe(200);
  clock += authPolicy.sessionTtlMs;
  expect(await errorCode(await call("/me", { method: "GET", cookie: secondCookie }))).toBe("UNAUTHENTICATED");
});

test("malformed or invalid input is a 400 validation error without echoing the input", async () => {
  for (const [path, body] of [["/otp/request", "{not json"], ["/otp/request", { email: "not-an-email" }], ["/otp/verify", { challengeId: "x", code: "12" }]] as const) {
    const response = await call(path, { body });
    expect(response.status).toBe(400);
    const error = apiErrorSchema.parse(await response.json()).error;
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(error)).not.toContain("not-an-email");
  }
});

test("console OTP delivery needs the explicit dev flag and a loopback host", async () => {
  const flag = { AUTH_DEV_LOG_OTP: "true" };
  const mail = { to: professor.email, code: "012345", challengeId: "challenge_x", expiresAt: new Date() };
  await expect(defaultMailer(flag, new URL(`${ORIGIN}/v1`))(mail)).rejects.toThrow("EMAIL_PROVIDER_NOT_CONFIGURED");
  await expect(defaultMailer({}, new URL("http://127.0.0.1:4321/v1"))(mail)).rejects.toThrow("EMAIL_PROVIDER_NOT_CONFIGURED");
  const log = spyOn(console, "log").mockImplementation(() => {});
  await defaultMailer(flag, new URL("http://127.0.0.1:4321/v1"))(mail);
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

test("Resend adapter sends one idempotent request and surfaces provider errors", async () => {
  const requests: Request[] = [];
  const send = (status: number) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response("{}", { status });
  }) as typeof fetch;
  const mail = { to: professor.email, code: "012345", challengeId: "challenge_x", expiresAt: new Date() };
  await resendMailer("re_test", "TeamPlanet <login@example.invalid>", send(200))(mail);
  expect(requests[0]!.headers.get("Idempotency-Key")).toBe("challenge_x");
  expect(await requests[0]!.json()).toMatchObject({ to: [professor.email], from: "TeamPlanet <login@example.invalid>" });
  await expect(resendMailer("re_test", "x@example.invalid", send(422))(mail)).rejects.toThrow("EMAIL_PROVIDER_STATUS_422");
});
