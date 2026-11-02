import { consentTokenSchema, consentConfirmationLookupResponseSchema, consentConfirmResponseSchema, apiErrorSchema,
  type ConsentConfirmationLookupResponse } from "@teamplanet/contracts";

export type StudentConsentState = { phase: "ready" | "loading" | "review" | "confirmed" | "blocked";
  details: ConsentConfirmationLookupResponse | null; error: string; retryAt: number };
type Fetcher = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
class StudentFailure extends Error {}

// The token is a personal invitation capability. It never becomes a professor session or a student ID parameter.
export class StudentConsentController {
  private token: string | null;
  private state: StudentConsentState;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private revision = 0;
  constructor(fragment: string, private fetcher: Fetcher = fetch, private clock = Date.now) {
    const parsed = consentTokenSchema.safeParse(fragment.replace(/^#/, ""));
    this.token = parsed.success ? parsed.data : null;
    this.state = { phase: this.token ? "ready" : "blocked", details: null,
      error: this.token ? "" : "개인 확인 링크가 없거나 올바르지 않습니다. 담당 교수에게 본인 링크를 다시 받으세요.", retryAt: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<StudentConsentState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  dispose() { this.revision++; this.controller?.abort(); this.token = null; }
  private async request(path: "lookup" | "confirm", signal: AbortSignal) {
    const fetcher = this.fetcher;
    const response = await fetcher(`/v1/consent-confirmations/${path}`, { method: "POST", credentials: "omit", cache: "no-store",
      signal, headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(path === "lookup" ? { token: this.token } : { token: this.token, confirmed: true }) });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data);
      const retry = response.headers.get("Retry-After");
      const headerAt = retry && /^\d+$/.test(retry) ? this.clock() + Number(retry) * 1000 : Date.parse(retry ?? "") || 0;
      this.update({ retryAt: Math.max(headerAt, this.clock() + (parsed.success ? parsed.data.error.retryAfterSeconds ?? 0 : 0) * 1000) });
      throw new StudentFailure(response.status === 404 ? "만료·철회되었거나 더 이상 사용할 수 없는 링크입니다. 담당 교수에게 확인하세요."
        : response.status === 429 ? "요청이 많습니다. 대기 시간이 지난 뒤 다시 확인하세요."
        : "확인을 완료하지 못했습니다. 연결을 확인하고 다시 조회하세요.");
    }
    if (path === "confirm") {
      if (!consentConfirmResponseSchema.safeParse(data).success) throw new StudentFailure("확인 응답을 검증하지 못했습니다. 다시 조회하세요.");
      return null;
    }
    const parsed = consentConfirmationLookupResponseSchema.safeParse(data);
    if (!parsed.success) throw new StudentFailure("안내 내용을 확인하지 못했습니다. 담당 교수에게 문의하세요.");
    if (!parsed.data.confirmedAt && Date.parse(parsed.data.expiresAt) <= this.clock()) throw new StudentFailure("링크가 만료되었습니다. 담당 교수에게 새 링크를 받으세요.");
    return parsed.data;
  }
  private async run(confirm: boolean) {
    if (!this.token || this.state.phase === "loading" || this.clock() < this.state.retryAt) return;
    const controller = this.controller = new AbortController();
    const revision = ++this.revision;
    const timer = setTimeout(() => controller.abort(), 12_000);
    this.update({ phase: "loading", details: null, error: "" });
    try {
      if (confirm) await this.request("confirm", controller.signal);
      if (revision !== this.revision) return;
      const details = await this.request("lookup", controller.signal);
      if (revision === this.revision && details) this.update({ phase: details.confirmedAt ? "confirmed" : "review", details });
    } catch (error) {
      if (revision === this.revision) this.update({ phase: "blocked", details: null,
        error: error instanceof StudentFailure ? error.message : "연결을 확인하지 못했습니다. 다시 조회해 처리 상태를 확인하세요." });
    } finally { clearTimeout(timer); }
  }
  lookup = () => this.run(false);
  confirm(checked: boolean) {
    if (!checked || this.state.phase !== "review") return;
    return this.run(true);
  }
}
