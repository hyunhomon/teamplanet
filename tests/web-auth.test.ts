import { describe, expect, test } from "bun:test";
import { auth, failures } from "@teamplanet/contracts/fixtures";
import { AuthController } from "../apps/web/src/lib/auth";

const start = Date.parse("2026-10-26T00:00:00.000Z");
const json = (data: unknown, status = 200, headers?: HeadersInit) => Response.json(data, { status, headers });

function harness() {
  let time = start;
  const calls: { url: string; init: RequestInit }[] = [];
  const replies: (() => Promise<Response>)[] = [];
  const fetcher = (async (url: string | URL | Request, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected fetch");
    return reply();
  }) as typeof fetch;
  const controller = new AuthController(fetcher, () => time);
  return { controller, calls, replies, advance: (ms: number) => { time += ms; controller.tick(); },
    reply: (response: Response) => replies.push(async () => response) };
}

async function signedOut(h: ReturnType<typeof harness>) {
  h.reply(json(failures.signedOut.body, 401));
  await h.controller.checkSession();
}
async function codeRequested(h: ReturnType<typeof harness>) {
  await signedOut(h);
  h.reply(json(auth.accepted, 202));
  await h.controller.requestCode(auth.request.email);
}

describe("professor login with shared API contracts", () => {
  test("calls browser fetch without binding it to the controller", async () => {
    let receiver: unknown = "not called";
    const fetcher = async function (this: unknown) {
      receiver = this;
      return json(failures.signedOut.body, 401);
    };
    const controller = new AuthController(fetcher, () => start);
    await controller.checkSession();
    expect(receiver).toBeUndefined();
    expect(controller.getSnapshot().phase).toBe("signed_out");
  });

  test("workspace stays concealed until a cookie-backed /me succeeds", async () => {
    const h = harness();
    expect(h.controller.getSnapshot().phase).toBe("checking");
    expect(h.controller.getSnapshot().session).toBeNull();
    await codeRequested(h);
    h.reply(json(auth.session));
    let confirm!: (response: Response) => void;
    h.replies.push(() => new Promise(resolve => { confirm = resolve; }));
    const verify = h.controller.verifyCode("123456");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.controller.getSnapshot().phase).toBe("checking");
    expect(h.controller.getSnapshot().session).toBeNull();
    confirm(json(auth.session));
    await verify;
    expect(h.controller.getSnapshot().phase).toBe("authenticated");
    expect(h.controller.getSnapshot().challenge).toBeNull();
    expect(h.controller.getSnapshot().email).toBe("");
    expect(h.calls.map(call => call.url)).toEqual([
      "/v1/auth/me", "/v1/auth/otp/request", "/v1/auth/otp/verify", "/v1/auth/me",
    ]);
    expect(JSON.parse(String(h.calls[2]!.init.body))).toEqual(auth.verify);
    for (const call of h.calls) {
      expect(call.init.credentials).toBe("same-origin");
      expect(call.init.cache).toBe("no-store");
    }
  });

  test("invalid form values never reach the API; leading-zero OTP is preserved", async () => {
    const h = harness();
    await signedOut(h);
    await h.controller.requestCode("not-an-email");
    expect(h.calls).toHaveLength(1);
    h.reply(json(auth.accepted, 202));
    await h.controller.requestCode("PROFESSOR-A@example.invalid");
    expect(h.controller.getSnapshot().email).toBe(auth.request.email);
    await h.controller.verifyCode("123");
    expect(h.calls).toHaveLength(2);
    h.reply(json(failures.invalidOtp.body, 401));
    await h.controller.verifyCode("001234");
    expect(JSON.parse(String(h.calls[2]!.init.body)).code).toBe("001234");
    expect(h.controller.getSnapshot().error).toContain("올바르지 않거나");
    expect(h.controller.getSnapshot().phase).toBe("code");
  });

  test("duplicate sends are ignored; resend and 429 use the later server deadline", async () => {
    const h = harness();
    await codeRequested(h);
    await h.controller.requestCode(auth.request.email);
    expect(h.calls).toHaveLength(2);
    h.advance(60_000);
    h.reply(json(failures.rateLimited.body, 429, { "Retry-After": "120" }));
    await h.controller.requestCode(auth.request.email);
    expect(h.controller.getSnapshot().retryAt).toBe(start + 180_000);
    h.advance(60_000);
    await h.controller.verifyCode("123456");
    await h.controller.requestCode(auth.request.email);
    expect(h.calls).toHaveLength(3);
    h.controller.changeEmail();
    await h.controller.requestCode("other@example.invalid");
    expect(h.calls).toHaveLength(3);
    h.advance(60_000);
    let resolve!: (response: Response) => void;
    h.replies.push(() => new Promise(done => { resolve = done; }));
    const first = h.controller.requestCode(auth.request.email);
    await h.controller.requestCode(auth.request.email);
    expect(h.calls).toHaveLength(4);
    resolve(json({ ...auth.accepted, expiresAt: new Date(start + 600_000).toISOString() }, 202));
    await first;
    expect(h.controller.getSnapshot().phase).toBe("code");
  });

  test("expired code is blocked locally and expired server code can be resent", async () => {
    const h = harness();
    await codeRequested(h);
    h.reply(json(failures.expiredOtp.body, 401));
    await h.controller.verifyCode("123456");
    expect(h.controller.getSnapshot().expiredCode).toBe(true);
    await h.controller.verifyCode("123456");
    expect(h.calls).toHaveLength(3);
    h.advance(60_000);
    h.reply(json(auth.accepted, 202));
    await h.controller.requestCode(auth.request.email);
    expect(h.controller.getSnapshot().expiredCode).toBe(false);
    h.advance(240_000);
    await h.controller.verifyCode("123456");
    expect(h.calls).toHaveLength(4);
    expect(h.controller.getSnapshot().expiredCode).toBe(true);
  });

  test("provider failure is recoverable and never becomes a fabricated send success", async () => {
    const h = harness();
    await signedOut(h);
    h.reply(json(failures.emailUnavailable.body, 503));
    await h.controller.requestCode(auth.request.email);
    expect(h.controller.getSnapshot().phase).toBe("signed_out");
    expect(h.controller.getSnapshot().challenge).toBeNull();
    expect(h.controller.getSnapshot().error).toContain("보내지 못했습니다");
    h.reply(json(auth.accepted, 202));
    await h.controller.requestCode(auth.request.email);
    expect(h.controller.getSnapshot().phase).toBe("code");
  });

  test("email change discards a late request response even if the transport ignores abort", async () => {
    const h = harness();
    await signedOut(h);
    let resolve!: (response: Response) => void;
    h.replies.push(() => new Promise(done => { resolve = done; }));
    const pending = h.controller.requestCode(auth.request.email);
    h.controller.changeEmail();
    expect(h.calls[1]!.init.signal?.aborted).toBe(true);
    resolve(json(auth.accepted, 202));
    await pending;
    expect(h.controller.getSnapshot().phase).toBe("signed_out");
    expect(h.controller.getSnapshot().challenge).toBeNull();
  });

  test("session expiry removes all identity and a late recheck cannot undo logout", async () => {
    const h = harness();
    h.reply(json(auth.session));
    await h.controller.checkSession();
    h.advance(8 * 60 * 60 * 1000);
    expect(h.controller.getSnapshot().session).toBeNull();
    expect(h.controller.getSnapshot().notice).toContain("만료");
    const freshSession = { ...auth.session, expiresAt: new Date(start + 9 * 60 * 60 * 1000).toISOString() };
    h.reply(json(freshSession));
    await h.controller.checkSession();
    let resolve!: (response: Response) => void;
    h.replies.push(() => new Promise(done => { resolve = done; }));
    const recheck = h.controller.checkSession();
    expect(h.controller.getSnapshot().session).toBeNull();
    h.reply(json(auth.logout));
    expect(await h.controller.logout()).toBe(true);
    resolve(json(freshSession));
    await recheck;
    expect(h.controller.getSnapshot().phase).toBe("signed_out");
    expect(h.controller.getSnapshot().session).toBeNull();
  });

  test("logout failure hides identity, reports unconfirmed server logout, and can retry", async () => {
    const h = harness();
    h.reply(json(auth.session));
    await h.controller.checkSession();
    h.replies.push(async () => { throw new TypeError("offline"); });
    expect(await h.controller.logout()).toBe(false);
    expect(h.controller.getSnapshot().phase).toBe("logout_failed");
    expect(h.controller.getSnapshot().session).toBeNull();
    await h.controller.checkSession();
    expect(h.calls).toHaveLength(2);
    h.reply(json(auth.logout));
    expect(await h.controller.logout()).toBe(true);
    expect(h.calls[2]!.init.method).toBe("POST");
  });

  test("missing cookie, expired session, malformed success, and unavailable API never reveal workspace", async () => {
    const h = harness();
    await codeRequested(h);
    h.reply(json(auth.session));
    h.reply(json(failures.signedOut.body, 401));
    await h.controller.verifyCode("123456");
    expect(h.controller.getSnapshot().phase).toBe("signed_out");
    expect(h.controller.getSnapshot().notice).toContain("쿠키");
    h.advance(9 * 60 * 60 * 1000);
    h.reply(json(auth.session));
    await h.controller.checkSession();
    expect(h.controller.getSnapshot().session).toBeNull();
    h.reply(json({ professor: auth.session.professor }));
    await h.controller.checkSession();
    expect(h.controller.getSnapshot().phase).toBe("unavailable");
    h.reply(new Response("not JSON", { status: 502 }));
    await h.controller.checkSession();
    expect(h.controller.getSnapshot().phase).toBe("unavailable");
    expect(h.controller.getSnapshot().session).toBeNull();
  });
});
