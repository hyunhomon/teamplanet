import { useEffect, useState, useSyncExternalStore } from "react";
import { StudentConsentController } from "../lib/student-consent";

export default function StudentConsent() {
  const [controller] = useState(() => new StudentConsentController(typeof window === "undefined" ? "" : window.location.hash));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [checked, setChecked] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void controller.lookup();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const changed = () => { controller.dispose(); window.location.reload(); };
    window.addEventListener("hashchange", changed);
    return () => { clearInterval(timer); window.removeEventListener("hashchange", changed); controller.dispose(); };
  }, [controller]);
  useEffect(() => { setChecked(false); }, [state.phase]);
  const waiting = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const expired = state.details && !state.details.confirmedAt && Date.parse(state.details.expiresAt) <= now;
  return <section className="auth-card student-consent" aria-labelledby="student-consent-title">
    <p className="eyebrow">STUDENT CONSENT</p><h1 id="student-consent-title">오프라인 동의서 재확인</h1>
    <p>담당 교수에게 직접 받은 본인 전용 링크로만 진행하세요. 다른 사람에게 전달하거나 단체 채널에 공유하지 마세요.</p>
    {(state.phase === "ready" || state.phase === "loading") && <p role="status" aria-busy="true">본인 확인 안내를 불러오고 있습니다.</p>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {state.details && <>
      <dl><dt>수업</dt><dd>{state.details.courseName}</dd><dt>공식 팀</dt><dd>{state.details.teamName}</dd><dt>학생</dt><dd>{state.details.studentDisplayName}</dd><dt>동의서 버전</dt><dd>{state.details.version}</dd></dl>
      <p>담당 교수: <a href={`mailto:${state.details.professorEmail}`}>{state.details.professorEmail}</a></p>
      {state.phase === "review" && <>
        <h2>처리 범위와 보관 안내</h2>
        <p>성인 내부 파일럿의 동의된 공식 공개 Slack 채널 내 대화·스레드·첨부 이미지를 다룹니다. DM·사적 채널과 동의 전 구간은 수집하지 않습니다.</p>
        <p>동의된 실제 표시명과 프로젝트 이미지 원본은 Qwen/DeepInfra ZDR로 실행 중 전송됩니다. 실제 처리 조건·지역과 이 화면의 서류 버전이 교수에게 받은 고지와 같은지 확인하세요. 다르거나 불명확하면 제출하지 말고 교수에게 문의하세요.</p>
        <p>Slack이 원문 저장소이며 서비스는 원문·이미지를 영구 복제하지 않고 링크·변경 확인 정보·요약·결과를 보관합니다. 관련 자료는 수업 종료 후 3개월에 삭제합니다. 이 파일럿은 성적에 반영하지 않는 참고·피드백용이며 교수가 최종 검토합니다.</p>
        <p>철회·정정·문의는 담당 교수에게 연락하세요. 이 확인만으로 수집이 시작되지 않으며 모든 참가자의 동의·계정·채널 권한을 별도로 검증합니다. Slack 가입 전에도 이 단계는 진행할 수 있습니다.</p>
        <form onSubmit={event => { event.preventDefault(); void controller.confirm(checked); }}>
          <label className="check-label"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} required />표시된 학생이 본인이며, 같은 버전의 오프라인 서류에 동의했음을 확인합니다.</label>
          <p className="field-help">이름·수업·버전이 다르면 체크하지 말고 담당 교수에게 알려 주세요.</p>
          {expired && <p className="form-error" role="alert">링크가 만료되었습니다. 새 링크를 받으세요.</p>}
          <button className="button primary" disabled={!checked || !!expired || waiting > 0}>동의서 재확인 제출</button>
        </form>
      </>}
      {state.phase === "confirmed" && <p className="form-notice" role="status">재확인을 기록했습니다. 기록 시각: {state.details.confirmedAt}. 다음 참여 안내는 담당 교수에게 받으세요.</p>}
    </>}
    {state.phase !== "ready" && state.phase !== "loading" && <button className="button secondary" disabled={waiting > 0} onClick={() => void controller.lookup()}>{waiting ? `${waiting}초 후 다시 조회` : "최신 상태 다시 조회"}</button>}
  </section>;
}
