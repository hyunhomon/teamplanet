import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { competencyLabels, runIdSchema, studentIdSchema, studentReportSchema, type StudentReport } from "@teamplanet/contracts";
import { judgementLabels } from "../lib/results";
import { limitationLabels } from "../lib/analysis-dashboard";
const date = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
const limit = (text: string) => limitationLabels[text] ?? text;
export default function StudentReportPage() {
  const [location] = useState(() => {
    const params = new URLSearchParams(window.location.search), run = runIdSchema.safeParse(params.get("run")), student = studentIdSchema.safeParse(params.get("student"));
    return run.success && student.success ? { run: run.data, student: student.data } : null;
  });
  const [report, setReport] = useState<StudentReport | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [checked, setChecked] = useState(false), [authorized, setAuthorized] = useState(false);
  const abort = useRef<AbortController | null>(null), pending = useRef(false), mounted = useRef(true), approvedAt = useRef(0);
  async function read(printing = false) {
    if (!location || pending.current) return;
    const previous = report;
    if (printing && (!checked || !previous)) return;
    pending.current = true; setBusy(true); setError(""); setAuthorized(false); setReport(null); setChecked(false);
    const controller = abort.current = new AbortController(), timeout = setTimeout(() => controller.abort(), 120000);
    try {
      if (printing) await document.fonts.ready;
      const response = await fetch(`/v1/analysis-runs/${location.run}/reports/${location.student}${printing ? "/print" : ""}`, {
        method: printing ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        ...(printing ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artifactHash: previous!.artifactHash,
          professorConfirmedAt: previous!.professorConfirmedAt, privacyReviewed: true, requestId: crypto.randomUUID() }) } : {}) });
      if (!mounted.current || controller.signal.aborted) return;
      if (!response.ok) {
        setChecked(false); setError(response.status === 401 ? "교수 로그인이 필요합니다. 로그인 후 이 페이지를 다시 확인하세요." : response.status === 503 ? "Slack 검증 장애로 출력하지 않습니다. 삭제로 판단하지 않았습니다."
          : response.status === 404 ? "접근할 수 없거나 이 실행에 속하지 않는 학생입니다." : "원문 변경·철회·만료·미확정 또는 버전 충돌로 출력할 수 없습니다. 이전 버전 정정 여부도 확인하세요."); return;
      }
      const next = studentReportSchema.parse(await response.json());
      if (!mounted.current || controller.signal.aborted) return;
      if (next.runId !== location.run || next.studentId !== location.student) throw Error();
      if (printing) {
        approvedAt.current = Date.now(); flushSync(() => { setReport(next); setAuthorized(true); });
        // Browser headers must not include internal student/run IDs.
        window.history.replaceState(null, "", "/reports/print");
        window.print();
      } else setReport(next);
    } catch { if (mounted.current) { setReport(null); setChecked(false); setError("검증된 리포트를 가져오지 못했습니다. 새로 확인하세요."); } }
    finally { clearTimeout(timeout); pending.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; void read();
    const before = () => {
      window.history.replaceState(null, "", "/reports/print");
      if (!approvedAt.current || Date.now() - approvedAt.current > 20000) flushSync(() => setAuthorized(false));
    };
    const after = () => { approvedAt.current = 0; setAuthorized(false); setChecked(false); setReport(null);
      if (location) window.history.replaceState(null, "", `/reports/print?run=${location.run}&student=${location.student}`); };
    const hidden = () => { if (document.visibilityState === "hidden" && !approvedAt.current) { abort.current?.abort(); setReport(null); setChecked(false); } };
    window.addEventListener("beforeprint", before); window.addEventListener("afterprint", after); document.addEventListener("visibilitychange", hidden);
    return () => { mounted.current = false; abort.current?.abort(); window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  return <main className={`student-report-page ${authorized ? "print-authorized" : ""}`}>
    <div className="report-controls"><a className="text-link" href="/workspace?view=analysis">교수 워크스페이스</a><h1>학생별 피드백 리포트 미리보기</h1>
      <p>학생 본인 피드백만 전달합니다. 다른 참가자 이름·개별 평가·연락처·전체 원문이 불필요하게 남지 않았는지 확인하세요.</p>
      {!location && <p className="form-error">유효한 실행과 학생을 결과 화면에서 선택하세요.</p>}
      {error && <p className="form-error" role="alert">{error} <a className="text-link" href="/login" target="_blank" rel="noopener noreferrer">교수 로그인</a></p>}
      <button className="button secondary" disabled={busy || !location} onClick={() => void read()}>{busy ? "현재 원문 재검증 중…" : "미리보기 다시 검증"}</button>
      {report && <><label className="check-label"><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} />학생 본인에게 전달할 자료이며, 타인 정보·전체 원문·불필요한 식별자가 없는지 확인했습니다.</label>
        <button className="button primary" disabled={!checked || busy} onClick={() => void read(true)}>원문 재검증 후 인쇄·PDF 저장</button></>}
      <p className="field-help">브라우저 인쇄 메뉴에서 PDF 저장을 선택할 수 있습니다. 출력 후에는 다시 검증해야 하며 기존 파일·종이는 자동 회수되지 않습니다.</p>
    </div>
    <p className="report-print-guard">출력이 승인되지 않았습니다. 미리보기에서 개인정보 확인 후 원문 재검증 버튼으로 인쇄하세요.</p>
    {report && <article className="report-document" aria-label="학생 개인 피드백 리포트"><header><p className="report-brand">TEAMPLANET · 교수 피드백</p><h1>{report.studentDisplayName}님의 커뮤니케이션 관찰</h1><p>{report.courseName}</p>
      <p className="report-purpose">{report.purpose}</p></header>
      <dl className="report-metadata"><div><dt>관찰 기간</dt><dd>{date(report.from)} - {date(report.to)} (한국 시각)</dd></div><div><dt>분석 버전·기준</dt><dd>버전 {report.runVersion} · {report.rubricVersion}</dd></div>
        <div><dt>교수 확인 완료</dt><dd>{date(report.professorConfirmedAt)}</dd></div><div><dt>출력 전 원문 검증</dt><dd>{date(report.verifiedAt)}</dd></div></dl>
      <section><h2>AI 관찰 개요</h2><p>{report.overview}</p><ul>{report.overviewLimitations.map((l,i) => <li key={i}>{limit(l)}</li>)}</ul></section>
      {report.cards.map(card => <section className="report-card" key={card.key}><h2>{competencyLabels[card.key]}</h2><p className="report-judgement">교수 최종 판단 · {judgementLabels[card.judgement]}</p><p>{card.narrative}</p>
        <h3>교수 검토·변경 사유</h3><p>{card.reason}</p><p className="report-ai-note">AI 초안: {judgementLabels[card.aiJudgement]} · AI 해석 신뢰도 {({ low: "낮음", medium: "중간", high: "높음" })[card.aiConfidence]}{card.aiRequestedHumanReview && " · AI 검토 요청을 교수가 확인한 항목"}</p>
        <h3>근거 요약</h3>{card.evidence.filter(e => e.kind === "support").length ? <ul>{card.evidence.filter(e => e.kind === "support").map((e,i) => <li key={i}>{e.summary}<ul>{e.limitations.map((l,j) => <li key={j}>{limit(l)}</li>)}</ul></li>)}</ul> : <p>관찰 가능한 근거가 부족합니다.</p>}
        <h3>반례</h3>{card.evidence.filter(e => e.kind === "counter").length ? <ul>{card.evidence.filter(e => e.kind === "counter").map((e,i) => <li key={i}>{e.summary}<ul>{e.limitations.map((l,j) => <li key={j}>{limit(l)}</li>)}</ul></li>)}</ul> : <p>이 범위에서 별도로 연결된 반례가 없습니다. 반례가 없음을 보장하지 않습니다.</p>}
        <h3>관찰 한계</h3><ul>{card.limitations.map((l,i) => <li key={i}>{limit(l)}</li>)}</ul>
      </section>)}
      <section><h2>검토 이견과 추가 한계</h2>{report.unresolvedIssues.length ? <ul>{report.unresolvedIssues.map((issue,i) => <li key={i}>{issue}</li>)}</ul> : <p>남은 모델 이견으로 기록된 항목은 없습니다.</p>}
        <ul>{report.reviewLimitations.map((l,i) => <li key={i}>{limit(l)}</li>)}</ul><p>관찰 불충분은 실패·낙제가 아닙니다. 오프라인 활동과 다른 도구의 대화는 이 자료로 판단하지 않습니다.</p></section>
      <footer><p>{report.correctionNotice}</p><p>서비스의 관련 자료는 수업 종료 후 달력 3개월 보관 정책을 따릅니다. 전달한 파일·종이의 관리와 정정은 별도로 확인하세요.</p></footer>
    </article>}
  </main>;
}
