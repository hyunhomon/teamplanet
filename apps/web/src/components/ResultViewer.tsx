import { useEffect, useState, useSyncExternalStore } from "react";
import { competencyLabels, type ResultResponse } from "@teamplanet/contracts";
import { ResultController } from "../lib/results";
import { limitationLabels } from "../lib/analysis-dashboard";
const limitation = (text: string) => limitationLabels[text] ?? ({ model_interpretation_requires_independent_review: "모델의 해석을 원문과 독립 대조해야 합니다.", image_interpretation_requires_review: "이미지 해석은 교수 확인이 필요합니다." } as Record<string,string>)[text] ?? text;
export const judgementLabels = { observed_strength: "관찰된 강점", mixed: "강점·반례 혼재", needs_support: "지원 필요", insufficient_evidence: "관찰 불충분" };
export function AnalysisHistory({ result }: { result: ResultResponse }) {
  const a = result.artifacts;
  const studentName = (id: string) => result.students.find(s => s.id === id)?.displayName;
  const assessment = (value: typeof a.originalAssessment) => <>
    {value.overviews.map(o => <section key={o.studentId}><h5>{studentName(o.studentId)} · 개요</h5><p>{o.summary}</p>
      {o.requiresHumanReview && <p>교수 검토 필요</p>}<ul>{o.limitations.map((l,i) => <li key={i}>{limitation(l)}</li>)}</ul></section>)}
    {value.assessments.map(r => <section key={`${r.studentId}:${r.key}`}><h5>{studentName(r.studentId)} · {competencyLabels[r.key]} · {judgementLabels[r.judgement]}</h5><p>{r.narrative}</p>
      {r.requiresHumanReview && <p>교수 검토 필요</p>}<ul>{r.limitations.map((l,i) => <li key={i}>{limitation(l)}</li>)}</ul></section>)}
  </>;
  const review = (value: typeof a.firstReview) => <>
    <p>{value.decision === "accept" ? "수용" : value.decision === "request_correction" ? "수정 요구" : "사람 검토"}{value.requiresHumanReview && " · 교수 검토 필요"}</p>
    {value.issues.map(i => <p key={i.id}>{studentName(i.studentId)} · {competencyLabels[i.competency]}: {i.instruction}</p>)}
    <ul>{value.limitations.map((l,i) => <li key={i}>{limitation(l)}</li>)}</ul>
  </>;
  return <details><summary>원래 AI 초안과 독립 검토·수정 이력</summary>
    <h4>원래 AI 초안</h4>{assessment(a.originalAssessment)}
    <h4>최초 독립 검토</h4>{review(a.firstReview)}
    {a.correction ? <><h4>AI 수정본 · 1회</h4>{assessment(a.correction.assessment)}<h4>최종 독립 재검토</h4>{review(a.finalReview)}</>
      : <p>AI 추가 수정 없이 최초 검토를 최종 검토로 사용했습니다.</p>}
  </details>;
}
export default function ResultViewer({ runId, onSignedOut }: { runId: string; onSignedOut(): void }) {
  const [controller] = useState(() => new ResultController(runId, onSignedOut));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot), result = state.result;
  useEffect(() => {
    void controller.load();
    const visibility = () => { if (document.visibilityState === "hidden") controller.clear(); else void controller.load(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); controller.dispose(); };
  }, [controller]);
  const refs = (ids: string[], label: string) => <div className="result-references"><h5>{label}</h5>{!ids.length ? <p>해당 근거가 없습니다.</p>
    : ids.map((id, i) => <button key={id} className="button secondary" disabled={state.busy} onClick={() => void controller.openEvidence(id)}>{label} {i + 1} 확인</button>)}</div>;
  return <section className="analysis-panel result-viewer" aria-labelledby="results-title">
    <div className="analysis-team-heading"><h3 id="results-title">결과와 원문 근거</h3><button className="button secondary" disabled={state.busy} onClick={() => void controller.load()}>{state.busy ? "현재 원문 검증 중…" : "원문 재검증·결과 새로고침"}</button></div>
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    {result && <>
      <p>분석 버전 {result.version} · {result.artifacts.snapshot.rubric.rubricVersion} · 검증 {new Date(result.verifiedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (한국 시각)</p>
      <p className="field-help">관찰한 대화의 정성적 피드백 후보입니다. 관찰 불충분은 실패·낙제가 아닙니다. 최종 판단은 교수가 합니다.</p>
      {result.artifacts.requiresHumanReview && <p className="form-notice">근거·한계·모델 이견을 확인하는 사람 검토가 필요합니다.</p>}
      {result.students.map(student => <article key={student.id} className="result-student"><h4>{student.displayName}</h4>
        <p>{result.artifacts.candidate.overviews.find(o => o.studentId === student.id)?.summary}</p>
        <ul>{result.artifacts.candidate.overviews.find(o => o.studentId === student.id)?.limitations.map((l,i) => <li key={i}>{limitation(l)}</li>)}</ul>
        {result.artifacts.candidate.assessments.filter(row => row.studentId === student.id).map(row => <section className="result-card" key={row.key}>
          <h5>{competencyLabels[row.key]} · {judgementLabels[row.judgement]}</h5><p>{row.narrative}</p>
          <p>판단 신뢰도: {({ low: "낮음", medium: "중간", high: "높음" })[row.confidence]} {row.requiresHumanReview && "· 교수 검토 필요"}</p>
          {refs(row.evidenceIds, "근거")}{refs(row.counterEvidenceIds, "반례")}
          <h6>관찰 한계</h6><ul>{row.limitations.map((l,i) => <li key={i}>{limitation(l)}</li>)}</ul>
        </section>)}
      </article>)}
      <AnalysisHistory result={result} />
    </>}
    {state.evidence && <section className="result-evidence" aria-live="polite"><h4>선택한 근거</h4><p>{state.evidence.summary}</p>
      <ul>{state.evidence.limitations.map((l,i) => <li key={i}>{l}</li>)}</ul>
      {state.evidence.messageIds.map((id,i) => <button className="button secondary" disabled={state.busy} key={id} onClick={() => void controller.openMessage(id)}>원문·스레드 문맥 {i + 1}</button>)}
    </section>}
    {state.context && <section className="result-context" aria-label="허용된 원문 문맥" aria-live="polite"><h4>허용 기간 안의 원문 문맥</h4>
      <p className="field-help">HTML과 링크는 실행하지 않고 텍스트로 표시합니다. 분석 기간 밖 문맥과 이미지 원문을 복제하지 않습니다.</p>
      {state.context.messages.map(m => <article key={m.id}><p><strong>{m.displayName}</strong> · {new Date(m.sentAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p><pre>{m.text}</pre>
        {m.images.map(image => <p className="form-notice" key={image.id}>첨부 이미지: 이 화면에서 원문을 제공하지 않습니다. 제약이 있거나 이미지 해석 확인이 필요합니다.</p>)}
        <ul>{m.limitations.map((l,i) => <li key={i}>{l}</li>)}</ul></article>)}
      {state.context.nextAfter && <button className="button secondary" disabled={state.busy} onClick={() => void controller.openMessage(state.context!.targetId, state.context!.nextAfter!)}>다음 문맥 더 보기</button>}
    </section>}
  </section>;
}
