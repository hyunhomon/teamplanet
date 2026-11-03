import { useEffect, useState } from "react";
import { inquiryListSchema, inquirySchema, inquirySettingsSchema, type Inquiry } from "@teamplanet/contracts";
import { inquiryRequest } from "../lib/inquiries";
const acknowledge = { parse: (x: unknown) => x };
export default function ProfessorInquiries({ courseId }: { courseId: string }) {
  const [days, setDays] = useState(""), [items, setItems] = useState<Inquiry[]>([]), [answers, setAnswers] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  async function refresh() {
    setItems([]);
    const [settings, list] = await Promise.all([inquiryRequest(`/courses/${courseId}/inquiry-settings`, inquirySettingsSchema, undefined, true),
      inquiryRequest(`/courses/${courseId}/inquiries`, inquiryListSchema, undefined, true)]);
    setDays(settings.days?.toString() ?? ""); setItems(list.inquiries);
    setMessage(settings.cleanupError ? "문의 자동 삭제 실패: 다음 cron에서 재시도합니다. 운영 확인이 필요합니다." : `마지막 자동 정리 확인: ${settings.lastCleanupAt ?? "아직 없음"}`);
  }
  async function perform(action: () => Promise<void>) { setBusy(true); try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : "연결을 확인하세요."); } finally { setBusy(false); } }
  useEffect(() => { void perform(refresh); const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <section aria-labelledby="prof-inquiries-title"><h2 id="prof-inquiries-title">학생 문의·답변</h2><p>기본 기한은 없습니다. 설정 변경은 새 문의에만 적용되며 답변해도 만료 시각은 바뀌지 않습니다.</p>
    <form onSubmit={e => { e.preventDefault(); void perform(async () => {
      await inquiryRequest(`/courses/${courseId}/inquiry-settings`, acknowledge, { days: Number(days) }, true, "PUT"); await refresh();
    }); }}><label>접수 후 답변 기한·자동 삭제 일수 n<input type="number" min="1" step="1" required value={days} onChange={e => setDays(e.target.value)} /></label><button className="button secondary" disabled={busy}>문의 기한 저장</button></form>
    <p role="status">{message}</p><button className="button secondary" disabled={busy} onClick={() => void perform(refresh)}>최신 문의 조회</button>
    {items.filter(i => Date.parse(i.expiresAt) > now).map(i => <article key={i.id}><p>문의 {i.id} · 접수 {i.receivedAt} · 만료 {i.expiresAt} ({i.days}일)</p>
      <p style={{ whiteSpace: "pre-wrap" }}>{i.body}</p><p style={{ whiteSpace: "pre-wrap" }}>현재 답변: {i.answer ?? "미답변"}</p>
      <form onSubmit={e => { e.preventDefault(); void perform(async () => { await inquiryRequest(`/inquiries/${i.id}/answer`, inquirySchema, { answer: answers[i.id] ?? "" }, true, "PUT"); setAnswers({}); await refresh(); }); }}>
        <label>답변<textarea required maxLength={4000} value={answers[i.id] ?? ""} onChange={e => setAnswers({ ...answers, [i.id]: e.target.value })} /></label><button className="button secondary" disabled={busy}>답변 저장</button></form>
      <p>요청 내용과 본인을 확인한 뒤 실제 철회/정정을 별도로 처리하세요. 접수만으로 동의 상태는 바뀌지 않습니다.</p>
      {(["withdrawal", "correction"] as const).map(kind => <button key={kind} className="button secondary" disabled={busy} onClick={() => void perform(async () => {
        await inquiryRequest(`/inquiries/${i.id}/action`, acknowledge, { kind }, true); await refresh(); setMessage(kind === "withdrawal" ? "철회를 처리하고 관련 작업을 중지했습니다." : "정정 요청에 따라 결과를 무효화했습니다. 재분석·검토가 필요합니다.");
      })}>{kind === "withdrawal" ? "본인 요청 확인 후 동의 철회 처리" : "정정 요청 확인 후 결과 무효화"}</button>)}
    </article>)}
  </section>;
}
