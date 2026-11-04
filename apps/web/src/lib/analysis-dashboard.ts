import { analysisDashboardSchema, analysisPreviewRequestSchema, analysisPreviewSchema, analysisRunListSchema, analysisRunResponseSchema,
  apiErrorSchema, createAnalysisRunSchema, runIdSchema, teamIdSchema, type AnalysisDashboard, type AnalysisPreview, type AnalysisRun } from "@teamplanet/contracts";
type Range = { from: string; to: string; timezone: string };
type Request = ReturnType<typeof createAnalysisRunSchema.parse>;
type Saved = { request: Request; runId: string | null };
type Schema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
export type DashboardState = { busy: boolean; error: string; notice: string; retryAt: number; stale: boolean;
  teams: AnalysisDashboard["teams"]; teamId: string; range: Range | null; preview: AnalysisPreview | null;
  runs: AnalysisRun[]; nextBefore: number | null; run: AnalysisRun | null; saved: Saved | null };
export const runningStatuses = new Set(["queued", "collecting", "evidence_extraction", "assessment", "review"]);
export const statusLabels: Record<AnalysisRun["status"], string> = {
  queued: "실행 대기", collecting: "전체 기간 수집 확인", evidence_extraction: "A · 근거 추출", assessment: "B · 선택 역량 평가", review: "C · 독립 검토",
  awaiting_professor: "교수 검토 대기", finalized: "교수 확정", blocked_provider_billing: "공급자 402 · 결제 제한", failed_provider_auth: "공급자 인증 오류",
  rate_limited: "요청 속도 제한", failed_model: "모델 처리 오류", failed_data: "자료 무효·접근 불가", cancelled: "취소됨",
};
export const blockLabels = {
  SETTINGS_REQUIRED: "수업 시작·종료일과 선택 역량을 설정하세요.", PERIOD_OUTSIDE_COURSE: "분석 기간은 수업 기간 안이어야 합니다.",
  FUTURE_PERIOD: "미래 시각은 분석할 수 없습니다.", DATA_USE_BLOCKED: "전원 동의·매핑·허용 수집 구간·자료 보관 상태를 확인하세요.",
  COVERAGE_INCOMPLETE: "전체 기간의 수집 확인이 완료되지 않았습니다. 운영자에게 수집 보정을 요청하세요.", NO_DATA: "이 기간에 관찰할 대화가 없습니다. 기간과 수집 상태를 확인하세요.",
};
export const limitationLabels: Record<string, string> = {
  source_metadata_preview_requires_live_revalidation: "메시지 참조 기준의 프리뷰입니다. 실행 때 Slack 원문을 다시 확인합니다.",
  image_metadata_is_not_complete_image_coverage: "이미지 수는 확인된 참조만 포함합니다. 누락 여부와 실제 접근 가능성은 실행 때 다시 확인합니다.",
  older_thread_replies_from_events_only: "기간 이전에 시작한 스레드의 답글은 실시간 수집 기록에 의존해 누락될 수 있습니다.",
  outside_allowed_window: "허용 수집 구간 밖의 대화가 제외됐습니다.", unconsented_author_excluded: "동의가 확인되지 않은 작성자의 대화가 제외됐습니다.",
  thread_root_outside_window: "일부 스레드의 시작 메시지가 분석 기간 밖에 있습니다.",
};
class DashboardFailure extends Error {
  constructor(readonly code: string, readonly retryAt = 0, readonly definitive = false) {
    super(code === "UNAUTHENTICATED" ? "세션이 만료되었습니다. 다시 로그인해 주세요." : code === "STORAGE_UNAVAILABLE" ? "이 브라우저에서 실행 요청을 복원할 수 없습니다. 브라우저의 사이트 저장소 설정을 확인하세요."
      : code === "CONFLICT" || code === "CONSENT_REQUIRED" ? "기간·동의·수집 상태가 바뀌었거나 재개할 수 없습니다. 최신 상태를 확인하세요."
      : code === "RATE_LIMITED" ? "요청이 많습니다. 표시된 대기 시간 뒤 다시 시도하세요." : code === "NOT_FOUND" ? "접근할 수 없거나 삭제된 팀·실행입니다."
      : "서버 상태를 확인하지 못했습니다. 실행 요청을 보냈다면 같은 요청 확인으로 복원하세요.");
  }
}
const sameRange = (a: Range, b: Range) => a.from === b.from && a.to === b.to && a.timezone === b.timezone;
const requestRange = ({ from, to, timezone }: Request): Range => ({ from, to, timezone });
export class DashboardController {
  private state: DashboardState;
  private listeners = new Set<() => void>();
  private revision = 0;
  private abort: AbortController | null = null;
  private storageKey: string;
  constructor(private signedOut: () => void, professorId: string,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private fetcher: typeof fetch = fetch, location = { teamId: "", runId: "" }, private clock = Date.now) {
    this.storageKey = `teamplanet-analysis:${professorId}`;
    let saved: Saved | null = null;
    try {
      const raw = JSON.parse(storage.getItem(this.storageKey) ?? "null");
      const request = createAnalysisRunSchema.safeParse(raw?.request), runId = runIdSchema.safeParse(raw?.runId);
      if (request.success && (raw.runId === null || runId.success)) saved = { request: request.data, runId: runId.success ? runId.data : null };
    } catch {}
    this.state = { busy: false, error: "", notice: "", retryAt: 0, stale: true, teams: [], teamId: location.teamId || saved?.request.teamId || "",
      range: saved ? { from: saved.request.from, to: saved.request.to, timezone: saved.request.timezone } : null,
      preview: null, runs: [], nextBefore: null, run: null, saved };
    this.initialRunId = location.runId || saved?.runId || "";
  }
  private initialRunId: string;
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<DashboardState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  dispose() { this.revision++; this.abort?.abort(); }
  private async request<T>(path: string, schema: Schema<T>, signal: AbortSignal, body?: unknown): Promise<T> {
    const send = this.fetcher;
    const result = await send(`/v1/${path}`, { method: body === undefined ? "GET" : "POST", signal, credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await result.json().catch(() => null);
    if (!result.ok) {
      const error = apiErrorSchema.safeParse(data), header = result.headers.get("Retry-After");
      const retryAt = header && /^\d+$/.test(header) ? this.clock() + Number(header) * 1000 : Date.parse(header ?? "") || 0;
      throw new DashboardFailure(result.status === 401 ? "UNAUTHENTICATED" : error.success ? error.data.error.code : "UNAVAILABLE",
        Math.max(retryAt, this.clock() + (error.success ? error.data.error.retryAfterSeconds ?? 0 : 0) * 1000), result.status < 500 && result.status !== 429);
    }
    const parsed = schema.safeParse(data); if (!parsed.success) throw new DashboardFailure("INVALID_RESPONSE"); return parsed.data;
  }
  private async perform(action: (signal: AbortSignal) => Promise<Partial<DashboardState>>) {
    if (this.state.busy || this.clock() < this.state.retryAt) return;
    this.dispose(); const revision = this.revision, controller = this.abort = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    this.update({ busy: true, error: "", notice: "" });
    try { const patch = await action(controller.signal); if (revision === this.revision) this.update({ ...patch, busy: false, stale: false }); }
    catch (error) {
      if (revision !== this.revision) return;
      const failure = error instanceof DashboardFailure ? error : new DashboardFailure("UNAVAILABLE");
      this.update({ busy: false, stale: true, error: failure.message, retryAt: failure.retryAt, preview: null });
      if (failure.code === "UNAUTHENTICATED") { this.update({ teams: [], runs: [], run: null, preview: null }); this.signedOut(); }
    } finally { clearTimeout(timeout); }
  }
  private async history(signal: AbortSignal, teamId: string, before?: number) {
    const page = await this.request(`teams/${teamId}/analysis-runs${before ? `?before=${before}` : ""}`, analysisRunListSchema, signal);
    if (page.teamId !== teamId || page.runs.some(r => r.teamId !== teamId) || new Set(page.runs.map(r => r.id)).size !== page.runs.length) throw new DashboardFailure("INVALID_RESPONSE");
    return page;
  }
  private checkRun(run: AnalysisRun, teamId: string, runId?: string) {
    if (run.teamId !== teamId || runId && run.id !== runId) throw new DashboardFailure("INVALID_RESPONSE"); return run;
  }
  load = () => this.perform(async signal => {
    const data = await this.request("analysis-dashboard", analysisDashboardSchema, signal);
    const restoredId = this.initialRunId;
    const selectedId = restoredId || this.state.run?.id;
    const run = selectedId ? await this.request(`analysis-runs/${selectedId}`, analysisRunResponseSchema, signal) : null;
    const teamId = this.state.teamId || run?.teamId || data.teams[0]?.team.id || "";
    if (teamId && !data.teams.some(t => t.team.id === teamId) || run && (run.teamId !== teamId || restoredId && run.id !== restoredId)) throw new DashboardFailure("NOT_FOUND");
    const page = teamId ? await this.history(signal, teamId) : { runs: [], nextBefore: null };
    this.initialRunId = "";
    return { teams: data.teams, teamId, runs: page.runs, nextBefore: page.nextBefore, run };
  });
  selectTeam(teamId: string) {
    if (this.state.busy || !teamIdSchema.safeParse(teamId).success || !this.state.teams.some(t => t.team.id === teamId)) return;
    this.initialRunId = ""; this.update({ teamId, preview: null, run: null, runs: [], range: null }); return this.load();
  }
  setRange(range: Range) {
    if (this.state.busy) return;
    this.update({ range, preview: null, error: "" });
  }
  invalidatePreview() { if (!this.state.busy) this.update({ preview: null, error: "" }); }
  preview = () => this.perform(async signal => {
    const request = analysisPreviewRequestSchema.safeParse({ teamId: this.state.teamId, ...this.state.range });
    if (!request.success) throw new DashboardFailure("CONFLICT");
    const result = await this.request("analysis-preview", analysisPreviewSchema, signal, request.data);
    if (result.teamId !== request.data.teamId || result.courseId !== this.state.teams.find(t => t.team.id === result.teamId)?.team.courseId || !sameRange(result, request.data)) throw new DashboardFailure("INVALID_RESPONSE");
    return { preview: result };
  });
  create = (recover = false) => this.perform(async signal => {
    let saved = this.state.saved;
    if (recover && saved?.runId) {
      const run = this.checkRun(await this.request(`analysis-runs/${saved.runId}`, analysisRunResponseSchema, signal), saved.request.teamId, saved.runId);
      const page = await this.history(signal, run.teamId);
      if (!sameRange(run, saved.request)) throw new DashboardFailure("INVALID_RESPONSE");
      return { run, teamId: run.teamId, range: requestRange(saved.request), preview: null, runs: page.runs, nextBefore: page.nextBefore };
    }
    if (saved && !recover) throw new DashboardFailure("CONFLICT");
    if (!saved) {
      const { preview, range, run } = this.state;
      if (!preview?.allowed || !range || !sameRange(preview, range) || preview.teamId !== this.state.teamId || this.clock() - Date.parse(preview.checkedAt) > 60000
        || run && runningStatuses.has(run.status)) throw new DashboardFailure("CONFLICT");
      saved = { request: createAnalysisRunSchema.parse({ teamId: this.state.teamId, ...range, idempotencyKey: crypto.randomUUID() }), runId: null };
      try { this.storage.setItem(this.storageKey, JSON.stringify(saved)); } catch { throw new DashboardFailure("STORAGE_UNAVAILABLE"); }
      this.update({ saved });
    }
    let run: AnalysisRun;
    try {
      run = this.checkRun(await this.request("analysis-runs", analysisRunResponseSchema, signal, saved.request), saved.request.teamId);
      if (!sameRange(run, saved.request)) throw new DashboardFailure("INVALID_RESPONSE");
    } catch (error) {
      if (error instanceof DashboardFailure && error.definitive && error.code !== "UNAUTHENTICATED") {
        try { this.storage.removeItem(this.storageKey); } catch {}
        this.update({ saved: null });
      }
      throw error;
    }
    saved = { request: saved.request, runId: run.id };
    try { this.storage.setItem(this.storageKey, JSON.stringify(saved)); } catch {} // The original request key remains recoverable.
    return { run, teamId: run.teamId, range: requestRange(saved.request), saved, preview: null, notice: "실행 요청을 접수했습니다. 완료 상태는 아래에서 확인하세요.",
      nextBefore: this.state.teamId === run.teamId ? this.state.nextBefore : null,
      runs: [run, ...this.state.runs.filter(r => r.teamId === run.teamId && r.id !== run.id)] };
  });
  selectRun = (runId: string) => this.perform(async signal => {
    if (!runIdSchema.safeParse(runId).success) throw new DashboardFailure("NOT_FOUND");
    const run = this.checkRun(await this.request(`analysis-runs/${runId}`, analysisRunResponseSchema, signal), this.state.teamId, runId);
    return { run, runs: this.state.runs.map(r => r.id === run.id ? run : r) };
  });
  poll = () => this.state.run ? this.selectRun(this.state.run.id) : Promise.resolve();
  action = (kind: "cancel" | "resume") => this.perform(async signal => {
    const selected = this.state.run; if (!selected) throw new DashboardFailure("CONFLICT");
    const run = this.checkRun(await this.request(`analysis-runs/${selected.id}/${kind}`, analysisRunResponseSchema, signal, {}), this.state.teamId, selected.id);
    return { run, runs: this.state.runs.map(r => r.id === run.id ? run : r), preview: null, notice: kind === "cancel" ? "서버의 취소 상태를 확인했습니다." : "재개 요청을 보냈습니다. 서버의 실제 진행 상태를 확인하세요." };
  });
  more = () => this.perform(async signal => {
    if (!this.state.nextBefore) return {};
    const page = await this.history(signal, this.state.teamId, this.state.nextBefore);
    return { runs: [...this.state.runs, ...page.runs.filter(r => !this.state.runs.some(old => old.id === r.id))], nextBefore: page.nextBefore };
  });
  newVersion() {
    if (this.state.busy || this.state.saved && (!this.state.run || this.state.saved.runId !== this.state.run.id)
      || this.state.run && runningStatuses.has(this.state.run.status)) return;
    try { this.storage.removeItem(this.storageKey); } catch { this.update({ error: new DashboardFailure("STORAGE_UNAVAILABLE").message }); return; }
    this.update({ saved: null, preview: null, run: null, error: "", notice: "새 버전은 기간 프리뷰를 확인한 뒤 직접 실행하세요." });
  }
}

/** Explicit UTC+09:00 input independent of the computer's timezone; rejects calendar normalization. */
export function seoulDateTime(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const iso = `${value}:00.000+09:00`, at = Date.parse(iso);
  if (!Number.isFinite(at) || new Date(at + 9 * 3600000).toISOString().slice(0, 16) !== value) return null;
  return new Date(at).toISOString();
}
export const seoulInput = (iso: string) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16);
