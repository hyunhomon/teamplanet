import { useEffect, useRef, useState, useSyncExternalStore, type SubmitEvent } from "react";
import { AuthController } from "../lib/auth";

const secondsUntil = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000));

export default function ProfessorWorkspace() {
  const [controller] = useState(() => new AuthController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    void controller.checkSession();
    const timer = window.setInterval(() => controller.tick(), 1000);
    const recheck = () => {
      if (document.visibilityState === "visible" && controller.getSnapshot().phase === "authenticated") {
        void controller.checkSession();
      }
    };
    const restore = (event: PageTransitionEvent) => { if (event.persisted) void controller.checkSession(); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    window.addEventListener("pageshow", restore);
    if (typeof BroadcastChannel !== "undefined") {
      channel.current = new BroadcastChannel("teamplanet-auth");
      channel.current.onmessage = event => {
        if (event.data === "signed-out") controller.resetSession("다른 탭에서 로그아웃했습니다. 다시 로그인해 주세요.");
      };
    }
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      window.removeEventListener("pageshow", restore);
      channel.current?.close();
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    if (state.phase === "code") codeInput.current?.focus();
    if (state.phase === "signed_out") { setEmail(""); setCode(""); emailInput.current?.focus(); }
    if (state.phase === "authenticated" || state.phase === "checking") { setEmail(""); setCode(""); }
    if (state.phase === "authenticated" || state.phase === "signed_out") {
      const path = state.phase === "authenticated" ? "/workspace" : "/login";
      window.history.replaceState(null, "", path);
      document.title = `${state.phase === "authenticated" ? "교수 워크스페이스" : "교수 로그인"} · TeamPlanet`;
    }
  }, [state.phase]);

  const requestCode = (event: SubmitEvent<HTMLFormElement>) => { event.preventDefault(); void controller.requestCode(email); };
  const verifyCode = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    void controller.verifyCode(code).finally(() => { setCode(""); codeInput.current?.focus(); });
  };
  const logout = async () => {
    if (await controller.logout()) channel.current?.postMessage("signed-out");
  };
  const busy = state.pending !== null;
  const retrySeconds = secondsUntil(state.retryAt, state.now);
  const resendSeconds = secondsUntil(Math.max(state.retryAt, Date.parse(state.challenge?.resendAvailableAt ?? "") || 0), state.now);
  const expiresSeconds = secondsUntil(Date.parse(state.challenge?.expiresAt ?? "") || 0, state.now);
  const expiredCode = state.expiredCode || expiresSeconds === 0;

  if (state.phase === "authenticated" && state.session) return (
    <section className="workspace" aria-labelledby="workspace-title">
      <div className="workspace-heading">
        <div><p className="eyebrow">PROFESSOR WORKSPACE</p><h1 id="workspace-title">교수 워크스페이스</h1></div>
        <button className="button secondary" onClick={() => void logout()}>로그아웃</button>
      </div>
      <p className="signed-in-as"><span>로그인 계정</span> {state.session.professor.email}</p>
      <div className="welcome-panel">
        <span className="pill">시작 안내</span>
        <h2>함께 나눈 대화, 근거 있는 피드백으로.</h2>
        <p>수업과 공식 Slack 채널을 연결하고 참가자 동의를 확인하는 기능을 준비하고 있습니다.</p>
        <p>수집과 분석은 고지·동의된 공식 채널에 한해 진행되며, 최종 평가는 교수님이 검토하고 확정합니다.</p>
      </div>
      <div className="workspace-grid">
        {[
          ["01", "수업과 Slack 연결", "수업·팀별 공식 채널과 참가자를 설정합니다."],
          ["02", "동의와 수집 상태", "참가자 동의와 수집 가능 상태를 확인합니다."],
          ["03", "분석과 교수 검토", "기간을 정해 분석하고 근거·반례·한계를 검토합니다."],
        ].map(([number, title, description]) => (
          <article className="workspace-card" key={number}>
            <p className="step-number">{number} /</p><h2>{title}</h2><p>{description}</p><span className="pill">준비 중</span>
          </article>
        ))}
      </div>
    </section>
  );

  if (state.phase === "checking") return (
    <section className="auth-card" aria-busy="true" aria-labelledby="checking-title">
      <p className="eyebrow">TEAMPLANET</p><h1 id="checking-title">{state.pending === "logout" ? "로그아웃 중입니다" : "로그인 상태를 확인하고 있습니다"}</h1>
      <p role="status">잠시만 기다려 주세요.</p>
    </section>
  );

  if (state.phase === "unavailable" || state.phase === "logout_failed") return (
    <section className="auth-card" aria-labelledby="unavailable-title">
      <p className="eyebrow">TEAMPLANET</p>
      <h1 id="unavailable-title">{state.phase === "logout_failed" ? "로그아웃을 완료하지 못했습니다" : "로그인 상태를 확인하지 못했습니다"}</h1>
      <p className="form-error" role="alert">{state.error}</p>
      {state.phase === "logout_failed" && <p>화면의 계정 정보는 지웠지만 서버의 세션 종료는 확인되지 않았습니다. 로그아웃을 다시 시도해 주세요.</p>}
      <button className="button primary" disabled={retrySeconds > 0} onClick={() => void (state.phase === "logout_failed" ? logout() : controller.checkSession())}>
        {retrySeconds > 0 ? `${retrySeconds}초 후 다시 시도` : state.phase === "logout_failed" ? "로그아웃 다시 시도" : "다시 확인"}
      </button>
      <a className="text-link" href="/">소개 화면으로</a>
    </section>
  );

  return (
    <section className="auth-card" aria-labelledby="login-title">
      <p className="eyebrow">PROFESSOR SIGN IN</p>
      <h1 id="login-title">{state.phase === "code" ? "메일의 인증 코드를 입력해 주세요" : "교수 워크스페이스에 로그인"}</h1>
      <p className="auth-description">{state.phase === "code" ? `${state.email} 주소로 요청했습니다.` : "등록된 교수 이메일로 일회용 인증 코드를 요청하세요."}</p>
      {state.notice && <p className="form-notice" role="status">{state.notice}</p>}
      {state.error && <p id="auth-error" className="form-error" role="alert">{state.error}</p>}
      {state.phase === "signed_out" ? (
        <form onSubmit={requestCode} aria-busy={busy}>
          <label htmlFor="email">교수 이메일</label>
          <input ref={emailInput} id="email" name="email" type="email" autoComplete="email" maxLength={254} required
            value={email} onChange={event => setEmail(event.target.value)} readOnly={busy}
            aria-describedby={state.error ? "auth-error" : "email-help"} />
          <p id="email-help" className="field-help">파일럿에 등록된 이메일을 사용해 주세요.</p>
          <button className="button primary" type="submit" disabled={busy || retrySeconds > 0}>
            {busy ? "인증 코드 요청 중…" : retrySeconds > 0 ? `${retrySeconds}초 후 요청 가능` : "인증 코드 받기"}
          </button>
        </form>
      ) : (
        <>
          <form onSubmit={verifyCode} aria-busy={busy}>
            <label htmlFor="otp">인증 코드 6자리</label>
            <input ref={codeInput} className="otp-input" id="otp" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
              pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code}
              onChange={event => setCode(event.target.value.replace(/[^0-9]/g, ""))} readOnly={busy || expiredCode}
              aria-describedby={`code-help${state.error ? " auth-error" : ""}`} />
            <p id="code-help" className="field-help">{expiredCode ? "인증 코드가 만료되었습니다. 새 코드를 요청해 주세요." : `유효 시간 ${Math.floor(expiresSeconds / 60)}분 ${expiresSeconds % 60}초`}</p>
            <button className="button primary" type="submit" disabled={busy || expiredCode || retrySeconds > 0}>
              {state.pending === "verify" ? "로그인 확인 중…" : retrySeconds > 0 ? `${retrySeconds}초 후 확인 가능` : "로그인"}
            </button>
          </form>
          <div className="auth-actions">
            <button className="button secondary" type="button" disabled={busy || resendSeconds > 0} onClick={() => { setCode(""); void controller.requestCode(state.email); }}>
              {state.pending === "request" ? "인증 코드 요청 중…" : resendSeconds > 0 ? `${resendSeconds}초 후 재전송` : "인증 코드 재전송"}
            </button>
            <button className="text-button" type="button" onClick={() => { setCode(""); controller.changeEmail(); }}>다른 이메일 사용</button>
          </div>
        </>
      )}
      <p className="auth-footnote">메일이 보이지 않으면 스팸함을 확인해 주세요. 계속 도착하지 않으면 파일럿 운영자에게 이메일 등록 여부를 확인해 주세요.</p>
    </section>
  );
}
