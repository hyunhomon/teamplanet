import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { consentConfirmationIssueResponseSchema, consentTokenSchema } from "@teamplanet/contracts";

export default function ConsentInvitation({ teamId, studentId, studentName, disabled }: {
  teamId: string; studentId: string; studentName: string; disabled: boolean;
}) {
  const [invitation, setInvitation] = useState<{ url: string; image: string; expiresAt: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifiedPerson, setVerifiedPerson] = useState(false);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; request.current?.abort(); }, []);
  const issue = async () => {
    if (inFlight.current || disabled || !verifiedPerson) return;
    inFlight.current = true;
    setBusy(true); setError(""); setInvitation(null);
    const controller = request.current = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/v1/teams/${teamId}/consents/${studentId}/confirmation`, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" },
      });
      const parsed = consentConfirmationIssueResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new Error();
      const url = new URL(parsed.data.confirmationUrl);
      if (url.origin !== window.location.origin || url.pathname !== "/consent/confirm" || url.search
        || !consentTokenSchema.safeParse(url.hash.slice(1)).success || Date.parse(parsed.data.expiresAt) <= Date.now()) throw new Error();
      const qr = qrcode(0, "M"); qr.addData(url.href); qr.make();
      if (alive.current) setInvitation({ url: url.href, image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag(4, 16))}`, expiresAt: parsed.data.expiresAt });
    } catch {
      if (alive.current) setError("개인 확인 링크를 발급하지 못했습니다. 동의서 확보·수업 설정·로그인 상태를 다시 확인하세요.");
    } finally { clearTimeout(timer); inFlight.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="consent-invitation">
    <label className="check-label"><input type="checkbox" checked={verifiedPerson} disabled={disabled || busy} onChange={event => setVerifiedPerson(event.target.checked)} />교수가 {studentName} 본인과 수업 초대를 확인했고 이 학생에게만 직접 전달합니다.</label>
    <button className="button secondary" disabled={disabled || busy || !verifiedPerson} onClick={() => void issue()}>{busy ? "개인 QR 발급 중…" : invitation ? "개인 QR 재발급" : "학생 개인 QR 발급"}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
    {invitation && <div>
      <p>이 학생만 사용하는 링크입니다. 단체 채널에 공유하지 마세요. 새로 발급하면 이전 미사용 링크는 무효가 됩니다.</p>
      <img width="240" height="240" src={invitation.image} alt={`${studentName}의 동의서 재확인 개인 QR`} />
      <p>링크 만료 시각: {invitation.expiresAt}</p>
      <a href={invitation.url} target="_blank" rel="noreferrer noopener">학생 재확인 페이지 열기</a>
    </div>}
  </div>;
}
