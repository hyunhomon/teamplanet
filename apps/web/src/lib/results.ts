import { resultResponseSchema, evidenceResponseSchema, messageContextSchema, assessmentSetSchema, apiErrorSchema,
  type ResultResponse, type MessageContext } from "@teamplanet/contracts";
class ResultFailure extends Error {}
export const judgementLabels = { observed_strength: "관찰된 강점", mixed: "강점·반례 혼재", needs_support: "지원 필요", insufficient_evidence: "관찰 불충분" };
export type ResultState = { busy: boolean; error: string; result: ResultResponse | null; context: MessageContext | null;
  evidence: ReturnType<typeof evidenceResponseSchema.parse>["evidence"] | null };
export class ResultController {
  private state: ResultState = { busy: false, error: "", result: null, context: null, evidence: null };
  private listeners = new Set<() => void>(); private abort: AbortController | null = null; private revision = 0;
  constructor(readonly runId: string, private signedOut: () => void, private fetcher: typeof fetch = fetch) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<ResultState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  clear() { this.revision++; this.abort?.abort(); this.update({ result: null, evidence: null, context: null, busy: false }); }
  dispose() { this.revision++; this.abort?.abort(); }
  async request<T>(path: string, schema: { parse(value: unknown): T }, signal: AbortSignal, body?: unknown): Promise<T> {
    const send = this.fetcher, response = await send(`/v1/analysis-runs/${this.runId}/${path}`, { method: body === undefined ? "GET" : "POST", signal,
      credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) { this.clear(); this.signedOut(); }
      const error = apiErrorSchema.safeParse(raw);
      throw new ResultFailure(response.status === 503 ? "Slack 원문 검증이 일시적으로 불가능합니다. 삭제로 판단하지 않았으며 확인·확정·출력을 보류합니다."
        : response.status === 409 ? "근거나 결과가 변경·무효화됐습니다. 최신 상태를 확인하고 새 분석·교수 재검토를 진행하세요."
        : response.status === 404 ? "접근할 수 없거나 이 실행에 속하지 않는 자료입니다."
        : error.success && error.data.error.code === "RATE_LIMITED" ? "요청이 많습니다. 잠시 뒤 다시 확인하세요." : "요청을 완료하지 못했습니다. 다시 확인하세요.");
    }
    return schema.parse(raw);
  }
  async perform(action: (signal: AbortSignal) => Promise<Partial<ResultState>>, clearResult = false) {
    if (this.state.busy) return;
    this.dispose(); const revision = this.revision, abort = this.abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 120000);
    this.update({ busy: true, error: "", context: null, ...(clearResult ? { result: null, evidence: null } : {}) });
    try { const patch = await action(abort.signal); if (revision === this.revision) this.update({ ...patch, busy: false }); }
    catch (error) { if (revision === this.revision) this.update({ result: null, context: null, evidence: null, busy: false,
      error: error instanceof ResultFailure ? error.message : "검증된 결과를 불러오지 못했습니다. 다시 확인하세요." }); }
    finally { clearTimeout(timeout); }
  }
  load = () => this.perform(async signal => {
    const result = await this.request("assessments", resultResponseSchema, signal), a = result.artifacts;
    if (result.runId !== this.runId || a.runId !== this.runId || a.candidate.runId !== this.runId) throw new ResultFailure("다른 실행의 응답을 사용할 수 없습니다.");
    assessmentSetSchema(a.snapshot.rubric, result.students.map(s => s.id), a.evidence.map(e => e.id)).parse(a.candidate.assessments);
    return { result };
  }, true);
  openEvidence = (id: string) => this.perform(async signal => {
    if (!this.state.result?.artifacts.evidence.some(e => e.id === id)) throw new ResultFailure("이 실행의 근거를 선택하세요.");
    const out = await this.request(`evidence/${id}`, evidenceResponseSchema, signal);
    if (out.runId !== this.runId || out.evidence.id !== id) throw new ResultFailure("근거 응답이 일치하지 않습니다.");
    return { evidence: out.evidence };
  });
  openMessage = (id: string, after?: string) => {
    const previous = this.state.context;
    return this.perform(async signal => {
      if (!this.state.evidence?.messageIds.includes(id)) throw new ResultFailure("선택한 근거의 원문을 선택하세요.");
      const context = await this.request(`messages/${id}${after ? `?after=${after}` : ""}`, messageContextSchema, signal);
      if (context.runId !== this.runId || context.targetId !== id) throw new ResultFailure("원문 응답이 일치하지 않습니다.");
      if (after && previous?.targetId === id) context.messages = [...previous.messages, ...context.messages.filter(m => !previous.messages.some(old => old.id === m.id))];
      return { context };
    });
  };
}

