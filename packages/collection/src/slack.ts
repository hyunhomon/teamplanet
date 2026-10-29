/** Slack token sealing and Web API calls shared by the API (#6/#7) and the consumer's History recovery (#12). */
export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;

const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function tokenKey(secret: string) {
  const raw = fromBase64(secret);
  if (raw.length !== 32) throw new Error("SLACK_TOKEN_KEY_INVALID");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
/** AES-GCM with the workspace ID as associated data, so a sealed token only opens for its own row. */
export async function sealToken(secret: string, workspaceId: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(workspaceId) }, await tokenKey(secret), encoder.encode(token),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}
export async function openToken(secret: string, workspaceId: string, sealed: string) {
  const [version, iv, data] = sealed.split(".");
  if (version !== "v1" || !iv || !data) throw new Error("SLACK_TOKEN_FORMAT");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(workspaceId) }, await tokenKey(secret), fromBase64(data),
  );
  return new TextDecoder().decode(plain);
}
export async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Slack error codes are short snake_case identifiers; log nothing else from Slack responses.
export const slackErrorCode = (body: unknown) => {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown";
};
// Untrusted Slack JSON; callers check every field they use.
export type SlackResult = { ok: true; body: Record<string, any> } | { ok: false; error: string; retryAfter?: number };
/** One Web API call with the bot token. Throws only on network failure. */
export async function callSlack(send: SlackFetch, token: string, method: string, params: Record<string, string>): Promise<SlackResult> {
  const response = await send(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.ok === true) return { ok: true, body };
  const retryAfter = Number(response.headers.get("Retry-After"));
  return { ok: false, error: response.status === 429 ? "ratelimited" : slackErrorCode(body), ...(retryAfter > 0 ? { retryAfter } : {}) };
}
