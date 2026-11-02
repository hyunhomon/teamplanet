import {
  apiErrorSchema, logoutResponseSchema, otpRequestResponseSchema, otpRequestSchema,
  otpVerifySchema, sessionResponseSchema,
  type OtpRequestResponse, type SessionResponse,
} from "@teamplanet/contracts";

type Phase = "checking" | "signed_out" | "code" | "authenticated" | "unavailable" | "logout_failed";
export type AuthState = {
  phase: Phase;
  pending: "request" | "verify" | "logout" | null;
  email: string;
  challenge: OtpRequestResponse | null;
  session: SessionResponse | null;
  error: string;
  notice: string;
  retryAt: number;
  now: number;
  expiredCode: boolean;
};

const messages: Record<string, string> = {
  OTP_INVALID: "인증 코드가 올바르지 않거나 이미 사용되었습니다. 다시 확인해 주세요.",
  OTP_EXPIRED: "인증 코드가 만료되었습니다. 새 코드를 요청해 주세요.",
  RATE_LIMITED: "요청이 많습니다. 표시된 대기 시간이 지난 후 다시 시도해 주세요.",
  EMAIL_DELIVERY_UNAVAILABLE: "인증 메일을 보내지 못했습니다. 잠시 후 다시 요청해 주세요.",
  FORBIDDEN: "요청을 확인할 수 없습니다. 페이지를 새로고침한 후 다시 시도해 주세요.",
  NOT_FOUND: "로그인 서비스를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
  UNAUTHENTICATED: "세션이 만료되었습니다. 다시 로그인해 주세요.",
};

class AuthFailure extends Error {
  constructor(readonly code: string, readonly retryAt = 0) {
    super(messages[code] ?? "로그인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

type Schema<T> = { safeParse: (data: unknown) => { success: true; data: T } | { success: false } };
type Fetcher = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

// No browser storage or production fixtures: only the HttpOnly cookie authenticates requests.
export class AuthController {
  private state: AuthState;
  private listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private generation = 0;

  constructor(private fetcher: Fetcher = fetch, private clock = Date.now) {
    this.state = this.empty("checking");
  }

  private empty(phase: Phase): AuthState {
    return { phase, pending: null, email: "", challenge: null, session: null,
      error: "", notice: "", retryAt: 0, now: this.clock(), expiredCode: false };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<AuthState>) {
    this.state = { ...this.state, ...patch, now: this.clock() };
    this.listeners.forEach(listener => listener());
  }
  private cancel() {
    this.generation++;
    this.request?.abort();
    this.request = null;
  }
  dispose() { this.cancel(); }

  resetSession(notice = "로그아웃했습니다.") {
    this.cancel();
    this.update({ ...this.empty("signed_out"), notice });
  }

  changeEmail() {
    // Keep a server-imposed request cooldown even when changing the email form.
    const retryAt = Math.max(this.state.retryAt, Date.parse(this.state.challenge?.resendAvailableAt ?? "") || 0);
    this.cancel();
    this.update({ ...this.empty("signed_out"), retryAt });
  }

  tick() {
    if (this.state.session && Date.parse(this.state.session.expiresAt) <= this.clock()) {
      this.resetSession("세션이 만료되었습니다. 다시 로그인해 주세요.");
    } else this.update({});
  }

  private async send<T>(path: string, schema: Schema<T>, controller: AbortController, body?: unknown): Promise<T> {
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      // Browser fetch rejects an AuthController instance as its receiver.
      const fetcher = this.fetcher;
      const response = await fetcher(`/v1/auth/${path}`, {
        method: body === undefined && path === "me" ? "GET" : "POST",
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(data);
        const retry = response.headers.get("Retry-After");
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 0;
        const retryAt = Math.max(
          retry && !seconds ? Date.parse(retry) || 0 : this.clock() + seconds * 1000,
          this.clock() + (parsed.success ? parsed.data.error.retryAfterSeconds ?? 0 : 0) * 1000,
        );
        throw new AuthFailure(parsed.success ? parsed.data.error.code : response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE", retryAt);
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new AuthFailure("UNAVAILABLE");
      return parsed.data;
    } finally { clearTimeout(timer); }
  }

  private begin(pending: AuthState["pending"]) {
    this.cancel();
    this.request = new AbortController();
    this.update({ pending, error: "", notice: "" });
    return { controller: this.request, generation: this.generation };
  }
  private failure(error: unknown) {
    const failure = error instanceof AuthFailure ? error : new AuthFailure("UNAVAILABLE");
    this.update({ pending: null, error: failure.message,
      retryAt: Math.max(this.state.retryAt, failure.retryAt),
      expiredCode: this.state.expiredCode || failure.code === "OTP_EXPIRED" });
  }

  async checkSession(signedOutNotice = "") {
    if (this.state.pending || this.state.phase === "logout_failed") return;
    const wasAuthenticated = this.state.phase === "authenticated";
    const operation = this.begin(null);
    this.update({ phase: "checking", session: null, challenge: null, email: "" });
    try {
      const session = await this.send("me", sessionResponseSchema, operation.controller);
      if (operation.generation !== this.generation) return;
      if (Date.parse(session.expiresAt) <= this.clock()) {
        this.resetSession("세션이 만료되었습니다. 다시 로그인해 주세요.");
      } else this.update({ phase: "authenticated", session });
    } catch (error) {
      if (operation.generation !== this.generation) return;
      if (error instanceof AuthFailure && error.code === "UNAUTHENTICATED") {
        this.resetSession(wasAuthenticated ? "세션이 만료되었습니다. 다시 로그인해 주세요." : signedOutNotice);
      } else {
        this.update({ phase: "unavailable" });
        this.failure(error);
      }
    }
  }

  async requestCode(email: string) {
    if (this.state.pending || !["signed_out", "code"].includes(this.state.phase)) return;
    const input = otpRequestSchema.safeParse({ email });
    if (!input.success) { this.update({ error: "올바른 이메일 주소를 입력해 주세요." }); return; }
    const resendAt = Date.parse(this.state.challenge?.resendAvailableAt ?? "") || 0;
    if (this.clock() < Math.max(resendAt, this.state.retryAt)) return;
    const operation = this.begin("request");
    try {
      const challenge = await this.send("otp/request", otpRequestResponseSchema, operation.controller, input.data);
      if (operation.generation !== this.generation) return;
      if (Date.parse(challenge.expiresAt) <= this.clock()) throw new AuthFailure("OTP_EXPIRED");
      this.update({ phase: "code", pending: null, email: input.data.email, challenge,
        expiredCode: false, notice: "등록된 교수 이메일이면 인증 코드가 도착합니다. 메일함과 스팸함을 확인해 주세요." });
    } catch (error) { if (operation.generation === this.generation) this.failure(error); }
  }

  async verifyCode(code: string) {
    if (this.state.pending || this.state.phase !== "code" || !this.state.challenge) return;
    if (this.clock() < this.state.retryAt) return;
    const input = otpVerifySchema.safeParse({ challengeId: this.state.challenge.challengeId, code });
    if (!input.success) { this.update({ error: "인증 코드 6자리를 입력해 주세요." }); return; }
    if (this.state.expiredCode || Date.parse(this.state.challenge.expiresAt) <= this.clock()) {
      this.update({ expiredCode: true, error: messages.OTP_EXPIRED }); return;
    }
    const operation = this.begin("verify");
    try {
      const session = await this.send("otp/verify", sessionResponseSchema, operation.controller, input.data);
      if (operation.generation !== this.generation) return;
      // Confirm the cookie was accepted before revealing the workspace.
      if (Date.parse(session.expiresAt) <= this.clock()) throw new AuthFailure("UNAUTHENTICATED");
      this.update({ pending: null, phase: "checking", challenge: null, email: "" });
      await this.checkSession("로그인 세션을 확인하지 못했습니다. 브라우저 쿠키 설정을 확인하고 다시 로그인해 주세요.");
    } catch (error) { if (operation.generation === this.generation) this.failure(error); }
  }

  async logout(): Promise<boolean> {
    if (this.state.pending === "logout") return false;
    const operation = this.begin("logout");
    this.update({ phase: "checking", session: null, email: "", challenge: null });
    try {
      await this.send("logout", logoutResponseSchema, operation.controller);
      if (operation.generation !== this.generation) return false;
      this.resetSession("로그아웃했습니다.");
      return true;
    } catch (error) {
      if (operation.generation === this.generation) {
        this.update({ phase: "logout_failed" });
        this.failure(error);
      }
      return false;
    }
  }
}
