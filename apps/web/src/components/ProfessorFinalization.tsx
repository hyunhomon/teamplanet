import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { competencyLabels, finalizeRequestSchema, finalizationResponseSchema, type ResultResponse, type ProfessorFinalization } from "@teamplanet/contracts";
import { judgementLabels } from "../lib/results";
export default function ProfessorFinalizationForm({ result, onSaved, onSignedOut, onVerificationFailed }: { result: ResultResponse; onSaved(): void; onSignedOut(): void; onVerificationFailed(message: string): void }) {
  const [decisions, setDecisions] = useState(() => result.artifacts.candidate.assessments.map(r => ({ studentId: r.studentId, key: r.key, judgement: r.judgement, narrative: r.narrative, reason: "" })));
  const [checked, setChecked] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [saved, setSaved] = useState<ProfessorFinalization | null>(null), [requestId] = useState(() => crypto.randomUUID());
  const inFlight = useRef(false), abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    if (result.status !== "finalized") return;
    const controller = abort.current = new AbortController();
    void fetch(`/v1/analysis-runs/${result.runId}/finalization`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async response => {
      if (response.status === 401) { onSignedOut(); return; }
      if (!response.ok) throw Error();
      const parsed = finalizationResponseSchema.parse(await response.json()); if (parsed.runId !== result.runId || !parsed.finalization) throw Error();
      if (!controller.signal.aborted) setSaved(parsed.finalization);
    }).catch(() => { if (!controller.signal.aborted) onVerificationFailed("확정본을 재검증하지 못했습니다. 최신 결과를 다시 조회하세요."); });
    return () => controller.abort();
  }, [result.runId, result.status]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; abort.current?.abort(); }; }, []);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault(); if (inFlight.current || !checked) return;
    const parsed = finalizeRequestSchema.safeParse({ requestId, expectedRunVersion: result.version, artifactHash: result.artifactHash, decisions,
      reviewedStudentIds: result.students.map(s => s.id), reviewedEvidenceIds: result.artifacts.evidence.map(e => e.id),
      reviewedIssueIds: [...new Set([...result.artifacts.firstReview.issues, ...result.artifacts.finalReview.issues].map(i => i.id))], limitationsReviewed: true, finalDecisionConfirmed: checked });
    if (!parsed.success) { setError("모든 역량의 판단과 검토·변경 사유를 작성하세요."); return; }
    inFlight.current = true; setBusy(true); setError("");
    const controller = abort.current = new AbortController(), timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(`/v1/analysis-runs/${result.runId}/finalize`, { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data) });
      if (!mounted.current || controller.signal.aborted) return;
      if (response.status === 401) { onSignedOut(); return; }
      if (!response.ok) { onVerificationFailed(response.status === 503 ? "원문 검증 장애로 확정을 보류했습니다. 다시 조회하세요." : "버전 충돌·필수 검토 누락·근거 변경으로 확정하지 못했습니다. 최신 결과를 다시 조회하세요."); return; }
      const confirmed = finalizationResponseSchema.parse(await response.json()); if (confirmed.runId !== result.runId || !confirmed.finalization) throw Error();
      if (!mounted.current || controller.signal.aborted) return;
      setSaved(confirmed.finalization); onSaved();
    } catch { if (mounted.current) onVerificationFailed("응답을 확인하지 못했습니다. 최신 결과를 다시 조회해 확정 여부를 확인하세요."); }
    finally { clearTimeout(timeout); inFlight.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className="professor-finalization"><h4>교수 최종 검토·확정</h4>
    <p>AI 초안은 보존됩니다. 근거 없는 판단을 만들지 말고 각 역량의 최종 판단과 사유를 기록하세요. 관찰 부족·반례·이견은 확정 후에도 유지됩니다.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {saved ? <div className="form-notice"><p>교수 확인 완료 · {new Date(saved.confirmedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })} (한국 시각)</p>
      {saved.assessments.map(row => <p key={`${row.studentId}:${row.key}`}>{result.students.find(s => s.id === row.studentId)?.displayName} · {competencyLabels[row.key]} · {judgementLabels[row.judgement]}: {row.narrative}</p>)}
      {saved.decisions.map(d => <p key={`${d.studentId}:${d.key}`}>검토·변경 사유{": "}{d.reason}</p>)}
      <p>원문 변경·철회·만료 시 이 확정본도 무효화됩니다. 수정이 필요하면 새 분석 버전에서 다시 검토하세요.</p></div>
      : result.status === "finalized" ? <p role="status">확정본을 다시 검증하고 있습니다.</p> : <form onSubmit={event => void submit(event)} aria-label="교수 최종 판단 확정">
        <fieldset disabled={busy}><legend>학생별 선택 역량의 최종 판단</legend>
          {decisions.map((d,i) => <div className="result-card" key={`${d.studentId}:${d.key}`}><h5>{result.students.find(s => s.id === d.studentId)?.displayName} · {competencyLabels[d.key]}</h5>
            <label htmlFor={`final-judgement-${i}`}>최종 판단</label><select id={`final-judgement-${i}`} value={d.judgement} onChange={e => { setChecked(false); setDecisions(values => values.map((v,j) => j === i ? { ...v, judgement: e.target.value as typeof d.judgement } : v)); }}>
              {Object.entries(judgementLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
            <label htmlFor={`final-narrative-${i}`}>교수 최종 서술</label><textarea id={`final-narrative-${i}`} required maxLength={4000} value={d.narrative} onChange={e => { setChecked(false); setDecisions(values => values.map((v,j) => j === i ? { ...v, narrative: e.target.value } : v)); }} />
            <label htmlFor={`final-reason-${i}`}>검토·변경 사유</label><textarea id={`final-reason-${i}`} required maxLength={1000} value={d.reason} onChange={e => { setChecked(false); setDecisions(values => values.map((v,j) => j === i ? { ...v, reason: e.target.value } : v)); }} />
          </div>)}
          <label className="check-label"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} />학생 전원과 모든 근거·반례·관찰 한계·모델 이견을 검토했으며, 위 판단을 교수의 최종 판단으로 확인합니다.</label>
          <button className="button primary" type="submit" disabled={!checked || busy}>{busy ? "원문 재검증·확정 중…" : "교수 판단 확정"}</button>
        </fieldset>
      </form>}
  </section>;
}

