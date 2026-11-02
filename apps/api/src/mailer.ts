export type OtpMail = { to: string; code: string; challengeId: string; expiresAt: Date };
export type Mailer = (mail: OtpMail) => Promise<void>;
export type MailBindings = { RESEND_API_KEY?: string; AUTH_EMAIL_FROM?: string; AUTH_DEV_LOG_OTP?: string };

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function resendMailer(apiKey: string, from: string, send: typeof fetch = fetch): Mailer {
  return async ({ to, code, challengeId }) => {
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": challengeId },
      body: JSON.stringify({
        from, to: [to], subject: "TeamPlanet 로그인 코드",
        text: `TeamPlanet 로그인 코드: ${code}\n\n5분 안에 입력하세요. 직접 요청하지 않았다면 이 메일을 무시하세요.`,
      }),
    });
    if (!response.ok) throw new Error(`EMAIL_PROVIDER_STATUS_${response.status}`);
  };
}

/** Console delivery needs both the explicit .dev.vars flag and a loopback request host. */
export function defaultMailer(env: MailBindings, url: URL): Mailer {
  if (env.AUTH_DEV_LOG_OTP === "true" && loopback.has(url.hostname)) {
    return async ({ to, code }) => console.log(`[local dev only] TeamPlanet OTP for ${to}: ${code}`);
  }
  if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM) return async () => { throw new Error("EMAIL_PROVIDER_NOT_CONFIGURED"); };
  return resendMailer(env.RESEND_API_KEY, env.AUTH_EMAIL_FROM);
}
