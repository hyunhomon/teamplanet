import { appendFile } from "node:fs/promises";

const account = "d09b11497e0618d6dceff0559855a7b2";
const required = ["SLACK_TOKEN_KEY", "OPENROUTER_API_KEY"] as const;
type Status = { status: "names_present" | "missing" | "unverified"; missing: string[]; httpStatus?: number };
/** Secret-list returns names, never values. Do not infer absence from an authorization/network failure. */
export async function inspectAnalysisSecretNames(env: Record<string, string | undefined>, fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): Promise<Status> {
  if (env.CLOUDFLARE_ACCOUNT_ID !== account || !env.CLOUDFLARE_API_TOKEN) return { status: "unverified", missing: [] };
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/teamplanet-consumer/secrets`, {
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, redirect: "manual", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { status: "unverified", missing: [], httpStatus: response.status };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("success" in body) || body.success !== true || !("result" in body) || !Array.isArray(body.result)) return { status: "unverified", missing: [] };
    if (body.result.some(item => !item || typeof item !== "object" || typeof item.name !== "string")) return { status: "unverified", missing: [] };
    const names = new Set(body.result.flatMap(item => item && typeof item === "object" && typeof item.name === "string" ? [item.name] : []));
    const missing = required.filter(name => !names.has(name));
    return { status: missing.length ? "missing" : "names_present", missing };
  } catch { return { status: "unverified", missing: [] }; }
}
if (import.meta.main) {
  const result = await inspectAnalysisSecretNames(process.env);
  const message = result.status === "names_present" ? "Consumer에 필요한 secret 이름이 등록돼 있습니다. 실제 키 유효성·모델 품질은 별도 검증 대상입니다."
    : result.status === "missing" ? `Consumer에 등록되지 않은 secret 이름: ${result.missing.join(", ")}. 실제 분석 전에 운영 설정이 필요합니다.`
    : `Consumer secret 이름 등록 여부를 확인하지 못했습니다${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}. 미등록으로 단정하지 않습니다.`;
  console.log(`[analysis configuration] ${message}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n### Analysis runtime configuration\n\n${message}\n\n이 검사는 값 조회나 실제 Slack/모델 호출을 수행하지 않습니다.\n`);
}
