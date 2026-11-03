import { useEffect, useState } from "react";
import { consentTokenSchema, inquirySchema, inquiryStudentViewSchema, type InquiryStudentView } from "@teamplanet/contracts";
import { inquiryRequest } from "../lib/inquiries";

export default function StudentInquiries() {
  const [token] = useState(() => typeof window === "undefined" ? "" : window.location.hash.slice(1));
  const [view, setView] = useState<InquiryStudentView | null>(null), [body, setBody] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  async function refresh() {
    setView(null); setError("");
    if (!consentTokenSchema.safeParse(token).success) { setError("담당 교수에게 받은 본인 QR 링크로 접근하세요."); return; }
    setView(await inquiryRequest("/student-inquiries/lookup", inquiryStudentViewSchema, { token }));
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "연결을 다시 확인하세요."); } finally { setBusy(false); }
  }
  useEffect(() => {
    void perform(refresh);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const changed = () => { setView(null); setBody(""); window.location.reload(); };
    window.addEventListener("hashchange", changed);
    return () => { clearInterval(timer); window.removeEventListener("hashchange", changed); };
  }, []);
  const canSubmit = view?.ticket && view.ticketExpiresAt && Date.parse(view.ticketExpiresAt) > now;
  return <section className="auth-card" aria-labelledby="inquiry-title"><p className="eyebrow">STUDENT INQUIRY</p><h1 id="inquiry-title">본인 웹 문의</h1>
    <p>개인 링크를 공유하지 마세요. 평가를 열람하는 화면은 아닙니다. 대화 원문·첨부를 복사하지 말고 필요한 문의만 적어 주세요.</p>
    {error && <p role="alert" className="form-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {view && <><p>담당 교수: <a href={`mailto:${view.professorEmail}`}>{view.professorEmail}</a></p>
      {view.days === null ? <p>교수가 문의 기한을 설정하기 전에는 접수할 수 없습니다. 이메일로 문의하세요.</p> : <p>답변 기한·보관기간: 접수 후 {view.days}일. 답변 여부와 관계없이 문의와 답변을 함께 삭제합니다.</p>}
      {canSubmit ? <form onSubmit={e => { e.preventDefault(); void perform(async () => {
        const result = await inquiryRequest("/student-inquiries", inquirySchema, { token, ticket: view.ticket, body });
        setBody(""); setNotice(`접수했습니다. 답변·보관 종료: ${result.expiresAt}`); await refresh();
      }); }}><p>지금 접수할 때의 예상 종료: {view.proposedExpiresAt}. 정확한 접수·만료 시각은 접수 결과에 표시됩니다.</p>
        <label>문의 내용<textarea required maxLength={4000} value={body} onChange={e => setBody(e.target.value)} /></label>
        <button className="button primary" disabled={busy}>문의 접수</button></form> : <p>접수 안내가 만료되었거나 신규 접수가 중지되었습니다. 최신 상태를 조회하세요.</p>}
      <h2>내 문의·답변</h2>{view.inquiries.filter(i => Date.parse(i.expiresAt) > now).map(i => <article key={i.id}>
        <p>접수: {i.receivedAt} · 종료: {i.expiresAt} ({i.days}일)</p><p style={{ whiteSpace: "pre-wrap" }}>{i.body}</p>
        <p style={{ whiteSpace: "pre-wrap" }}>교수 답변: {i.answer ?? "아직 답변이 없습니다."}</p>
      </article>)}<p>철회·정정 요청은 교수의 별도 처리 확인이 필요합니다. 문의 만료가 철회를 취소하지 않습니다.</p></>}
    <button className="button secondary" disabled={busy} onClick={() => void perform(refresh)}>최신 상태 조회</button>
  </section>;
}
