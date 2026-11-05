import { useEffect, useState, useSyncExternalStore, type SubmitEvent } from "react";
import { competencyLabels } from "@teamplanet/contracts";
import { DashboardController, blockLabels, limitationLabels, runningStatuses, seoulDateTime, seoulInput, statusLabels } from "../lib/analysis-dashboard";
import { setupLocation } from "../lib/setup";
import ResultViewer from "./ResultViewer";
const time = (iso: string | null) => iso ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "설정 안 됨";
const collectionLabel = { active: "수집 중", inactive: "수집 비활성", paused: "수집 중지" };
export default function AnalysisDashboard({ professorId, onSignedOut }: { professorId: string; onSignedOut(): void }) {
  const [controller] = useState(() => {
    // Access can itself throw when browser storage is disabled; the controller blocks creation safely.
    let storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    try { storage = window.sessionStorage; } catch { storage = { getItem() { return null; }, setItem() { throw Error(); }, removeItem() { throw Error(); } }; }
    return new DashboardController(onSignedOut, professorId, storage, fetch, setupLocation(window.location.search));
  });
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [inputError, setInputError] = useState(""), [now, setNow] = useState(Date.now());
  useEffect(() => {
    void controller.load();
    const timer = setInterval(() => {
      setNow(Date.now());
      const run = controller.getSnapshot().run;
      if (document.visibilityState === "visible" && run && runningStatuses.has(run.status)) void controller.poll();
    }, 5000);
    const refresh = () => { if (document.visibilityState === "visible") void controller.load(); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); controller.dispose(); };
  }, [controller]);
  useEffect(() => {
    setFrom(state.range ? seoulInput(state.range.from) : ""); setTo(state.range ? seoulInput(state.range.to) : "");
  }, [state.range]);
  useEffect(() => {
    if (state.stale || state.busy) return;
    const params = new URLSearchParams({ view: "analysis" });
    if (state.teamId) params.set("team", state.teamId);
    if (state.run) params.set("run", state.run.id);
    window.history.replaceState(null, "", `/workspace?${params}`);
  }, [state.teamId, state.run?.id, state.stale, state.busy]);
  const waiting = Math.max(0, Math.ceil((state.retryAt - now) / 1000)), disabled = state.busy || waiting > 0;
  const team = state.teams.find(t => t.team.id === state.teamId), run = state.run;
  const cannotResume = run?.errors.some(error => ["PROVIDER_OUTCOME_UNKNOWN", "MODEL_INVALID", "CONTEXT_LIMIT", "STAGE_INVALID"].includes(error.code));
  const preview = state.preview, fresh = preview && now - Date.parse(preview.checkedAt) <= 60000;
  const editPeriod = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom); setTo(nextTo); setInputError("");
    controller.invalidatePreview();
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault(); const a = seoulDateTime(from), b = seoulDateTime(to);
    if (!a || !b || a >= b) { setInputError("시작은 종료보다 앞서야 하며 실제 달력 날짜를 입력해야 합니다."); return; }
    controller.setRange({ from: a, to: b, timezone: "Asia/Seoul" }); void controller.preview();
  };
  return <div className="analysis-dashboard">
    <div className="setup-toolbar"><div><p className="eyebrow">MANUAL ANALYSIS</p><h2>팀 대화 분석</h2></div>
      <button className="button secondary" disabled={disabled} onClick={() => void controller.load()}>{state.busy ? "확인 중…" : "최신 상태 확인"}</button></div>
    <p className="field-help">동의한 공식 채널의 전체 기간을 분석합니다. 자동 실행과 성적 자동 확정은 하지 않으며, 최종 평가는 교수가 검토합니다.</p>
    {waiting > 0 && <p role="status">{waiting}초 후 다시 확인할 수 있습니다.</p>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {state.stale && state.run && <p className="form-error">아래 진행은 마지막으로 확인한 상태입니다. 최신 상태를 다시 확인하세요.</p>}
    {state.notice && <p className="form-notice" role="status">{state.notice}</p>}
    {state.saved && <div className="analysis-recovery"><p>{state.saved.runId ? "이 브라우저에 보존한 실행이 있습니다." : "응답이 확인되지 않은 실행 요청이 있습니다. 새 요청을 만들기 전에 같은 요청을 확인하세요."}</p>
      <button className="button secondary" disabled={disabled} onClick={() => void controller.create(true)}>{state.saved.runId ? "보존한 실행 보기" : "같은 실행 요청 확인"}</button>
      <p className="field-help">새로고침 뒤에도 기존 요청을 확인해 중복 분석을 방지합니다.</p></div>}
    {!state.teams.length && !state.busy && !state.error && <div className="welcome-panel"><h3>아직 분석할 팀이 없습니다</h3><p>수업·Slack 설정에서 공식 채널과 참가자 동의를 준비하세요.</p><a className="text-link" href="/workspace">수업·Slack 설정</a></div>}
    {state.teams.length > 0 && <>
      <label className="analysis-team-label">수업 / 팀<select value={state.teamId} disabled={disabled} onChange={event => { setFrom(""); setTo(""); void controller.selectTeam(event.target.value); }}>
        <option value="" disabled>팀 선택</option>{state.teams.map(t => <option key={t.team.id} value={t.team.id}>{t.courseName} / {t.team.name} · {collectionLabel[t.team.collectionStatus]} · 동의 {t.confirmed}/{t.members}</option>)}
      </select></label>
      {team && <section className="analysis-panel" aria-labelledby="period-title">
        <div className="analysis-team-heading"><h3 id="period-title">{team.team.name} · 분석 기간</h3><span className="pill">{collectionLabel[team.team.collectionStatus]}</span></div>
        <p>현재 참가자 {team.members}명 · 유효한 동의 재확인 {team.confirmed}명 · 매핑 전 참가자 {team.unmapped}명</p>
        {team.team.collectionStatus !== "active" && <p className="form-notice">현재 신규 수집은 중지돼 있습니다. 과거 허용 구간의 분석 가능 여부는 서버 프리뷰에서 확인하세요.</p>}
        <p>허용 수업 기간: {time(team.startsAt)} — {time(team.endsAt)} (한국 시각)</p>
        <p>선택 역량: {team.selection ? team.selection.selectedCompetencies.map(k => competencyLabels[k]).join(" · ") : "미설정"} {team.selection && <span className="pill">{team.selection.rubricVersion}</span>}</p>
        {(!team.selection || !team.startsAt || !team.endsAt) && <p className="form-error">수업 기간과 선택 역량을 먼저 설정하세요. <a className="text-link" href={`/workspace?course=${team.team.courseId}&team=${team.team.id}`}>설정으로 이동</a></p>}
        <form onSubmit={submit} aria-label="분석 기간 프리뷰"><fieldset disabled={disabled}><legend>한국 시각 (Asia/Seoul, UTC+09:00)</legend>
          <div className="analysis-period"><label>시작 시각<input type="datetime-local" required value={from} onChange={event => editPeriod(event.target.value, to)} /></label>
            <label>종료 시각<input type="datetime-local" required value={to} onChange={event => editPeriod(from, event.target.value)} /></label></div>
          <p className="field-help">시작 시각은 포함하고 종료 시각은 포함하지 않습니다. 미래 시각과 수업 기간 밖은 거부합니다.</p>
          {inputError && <p className="form-error" role="alert">{inputError}</p>}<button type="submit" className="button secondary">기간 프리뷰 확인</button>
        </fieldset></form>
        {preview && <div className="analysis-preview" aria-live="polite"><h4>서버 프리뷰</h4><p>{time(preview.from)} — {time(preview.to)}</p>
          <p>수집 확인: {preview.coverage.status === "complete" ? "전체 기간 확인 완료" : "전체 기간 확인 미완료"} · 마지막 확인 {time(preview.coverage.asOf)}</p>
          <dl className="analysis-metrics"><div><dt>메시지 참조</dt><dd>{preview.coverage.sources}</dd></div><div><dt>원문 재확인 필요</dt><dd>{preview.coverage.unverifiedSources}</dd></div>
            <div><dt>이미지 참조 / 제약</dt><dd>{preview.coverage.imageReferences} / {preview.coverage.imageLimitations}</dd></div><div><dt>기간 밖 시작 스레드 / 제외</dt><dd>{preview.coverage.threadRootsOutsidePeriod} / {preview.coverage.excluded}</dd></div></dl>
          <p>실행에 적용할 서버 선택: {preview.selection?.selectedCompetencies.map(k => competencyLabels[k]).join(" · ") ?? "미설정"}</p>
          {preview.reasons.length > 0 && <ul className="analysis-blocks">{preview.reasons.map(r => <li key={r}>{blockLabels[r]}</li>)}</ul>}
          <ul className="field-help">{preview.coverage.limitations.map(l => <li key={l}>{limitationLabels[l] ?? "수집 과정에서 추가 제약이 기록됐습니다. 실행 후 교수 검토에서 한계를 확인하세요."}</li>)}</ul>
          {!fresh && <p className="form-notice">프리뷰가 1분 지났습니다. 기간 프리뷰를 다시 확인하세요.</p>}
          <button className="button primary" disabled={disabled || state.stale || !preview.allowed || !fresh || !!state.saved || !!run && runningStatuses.has(run.status)} onClick={() => void controller.create()}>이 기간 분석 실행</button>
        </div>}
      </section>}
      {run && <section className="analysis-panel" aria-labelledby="run-title"><div className="analysis-team-heading"><h3 id="run-title">분석 버전 {run.version}</h3><span className="pill" role="status">{statusLabels[run.status]}</span></div>
        <p>{time(run.from)} — {time(run.to)} · {run.timezone}</p><p>실행에 고정된 역량: {run.snapshot.rubric.selectedCompetencies.map(k => competencyLabels[k]).join(" · ")} ({run.snapshot.rubric.rubricVersion})</p>
        <ol className="analysis-stages">{(["queued", "collecting", "evidence_extraction", "assessment", "review", "awaiting_professor"] as const).map(s => <li key={s} aria-current={run.status === s ? "step" : undefined}>{statusLabels[s]}</li>)}</ol>
        <p aria-live="polite">확인된 원문 {run.progress.sources}개 · A 처리 단위 {run.progress.completedChunks}/{run.progress.chunks}개</p>
        {run.status === "blocked_provider_billing" && <p className="form-error">실제 공급자 402로 중단됐습니다. 운영자가 공급자 잔액·키 제한·동시 요청 제한을 확인해야 합니다.</p>}
        {run.status === "failed_provider_auth" && <p className="form-error">공급자 인증을 확인해야 합니다. 운영자에게 요청하세요.</p>}
        {run.status === "rate_limited" && <p className="form-notice">공급자 요청 속도 제한입니다. 서버의 재시도 예약을 기다린 뒤 최신 상태를 확인하세요.</p>}
        {run.status === "failed_model" && <p className="form-error">모델의 출력 형식·문맥 한도 또는 공급자 처리 오류입니다. 운영자가 원인을 확인한 뒤 재개 가능 여부를 확인하세요.</p>}
        {run.status === "failed_data" && <p className="form-error">원문 변경·동의 철회·삭제 또는 접근 불가로 이 실행을 사용할 수 없습니다. 원인을 확인한 뒤 새 버전이 필요합니다.</p>}
        {run.errors.some(error => error.code === "PROVIDER_OUTCOME_UNKNOWN") && <p className="form-error">외부 모델 요청의 처리 결과를 확인할 수 없어 자동 재전송을 중지했습니다. 운영자가 공급자 기록을 확인한 뒤 새 분석 여부를 결정해야 합니다.</p>}
        {run.errors.some(error => error.code === "CONFIG_INVALID") && <p className="form-error">분석 Worker의 모델·API 키 설정을 확인해야 합니다. 운영자에게 요청하세요.</p>}
        {run.errors.some(error => error.code === "PROVIDER_RECEIPT_UNAVAILABLE") && <p className="form-notice">모델 결과는 보존됐으며 실제 공급자 확인만 재시도합니다. 같은 모델 요청을 다시 보내지 않습니다.</p>}
        {run.errors.some(e => e.code === "HANDLER_UNREGISTERED") && <p className="form-notice">분석 서비스를 준비 중입니다. 운영자에게 재개 가능 여부를 확인하세요.</p>}
        {run.errors.filter(e => e.code !== "HANDLER_UNREGISTERED").map((e, i) => <p className="field-help" key={`${e.code}:${i}`}>{e.code === "DATA_INVALIDATED" ? "입력이 무효화됐습니다." : e.code === "CONTEXT_LIMIT" ? "모델 문맥의 기술적 한도를 확인하세요." : e.code === "SOURCE_UNAVAILABLE" ? "Slack 원문에 접근할 수 없습니다." : "서버에서 처리 오류를 기록했습니다."} {e.retryable ? "서버 재시도 예정입니다." : "운영자 확인이 필요합니다."}</p>)}
        {run.status === "awaiting_professor" && <p className="form-notice">분석이 교수 검토 단계에 도달했습니다. 최종 평가 전 원문 근거와 한계에 대한 교수 검토가 필요합니다.</p>}
        <div className="analysis-actions"><button className="button secondary" disabled={disabled} onClick={() => void controller.poll()}>실행 상태 확인</button>
          {!["awaiting_professor", "finalized", "cancelled"].includes(run.status) && <button className="button secondary" disabled={disabled || state.stale} onClick={() => void controller.action("cancel")}>실행 취소</button>}
          {!["awaiting_professor", "finalized", "cancelled", "failed_data"].includes(run.status) && !runningStatuses.has(run.status) && !cannotResume && <button className="button secondary" disabled={disabled || state.stale} onClick={() => void controller.action("resume")}>재개 가능 여부 확인</button>}
          {run.errors.some(e => e.code === "HANDLER_UNREGISTERED") && <button className="button secondary" disabled={disabled || state.stale} onClick={() => void controller.action("resume")}>처리 연결 후 재개</button>}
          {!runningStatuses.has(run.status) && <button className="button secondary" disabled={disabled || state.stale} onClick={() => controller.newVersion()}>새 분석 버전 준비</button>}</div>
        <p className="field-help">새 버전은 기존 실행을 덮어쓰지 않습니다. 분석 후보는 교수의 최종 확정이 아닙니다.</p>
      </section>}
      {run && ["awaiting_professor", "finalized"].includes(run.status) && <ResultViewer key={run.id} runId={run.id} onSignedOut={onSignedOut} onFinalized={() => void controller.poll()} />}
      <section className="analysis-panel" aria-labelledby="history-title"><h3 id="history-title">실행 이력</h3>
        {!state.runs.length && <p>이 팀의 분석 실행이 아직 없습니다.</p>}
        <ul className="analysis-history">{state.runs.map(r => <li key={r.id}><button className="text-button" disabled={disabled} onClick={() => void controller.selectRun(r.id)}>버전 {r.version} · {time(r.from)} — {time(r.to)}</button><span>{statusLabels[r.id === run?.id ? run.status : r.status]}</span></li>)}</ul>
        {state.nextBefore && <button className="button secondary" disabled={disabled} onClick={() => void controller.more()}>이전 실행 더 보기</button>}
      </section>
    </>}
  </div>;
}
