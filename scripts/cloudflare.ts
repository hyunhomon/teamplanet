export const PRODUCTION_ACCOUNT = "d09b11497e0618d6dceff0559855a7b2";
export const PRODUCTION_DATABASE = "086fd3c2-d33b-4fc2-9a6c-91df7305c8b9";
export const QUEUES = ["teamplanet-jobs-dlq", "teamplanet-jobs"] as const;
type ApiResponse<T> = { success: boolean; result: T; errors?: { code: number }[] };
export type CfRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function cloudflareRequest(env: Record<string, string | undefined> = process.env, request: typeof fetch = fetch): CfRequest {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token || env.CLOUDFLARE_ACCOUNT_ID !== PRODUCTION_ACCOUNT) throw new Error("Set CLOUDFLARE_API_TOKEN and the TeamPlanet production CLOUDFLARE_ACCOUNT_ID; no credential values are logged.");
  return async <T>(path: string, method = "GET", body?: unknown) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${PRODUCTION_ACCOUNT}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    let data: ApiResponse<T> | undefined;
    try { data = await response.json() as ApiResponse<T>; } catch { /* Never echo upstream HTML/credentials. */ }
    if (!response.ok || !data?.success) {
      const codes = data?.errors?.map(error => error.code).filter(Number.isInteger).join(",") || "unknown";
      throw new Error(`Cloudflare ${method} ${path.split("?")[0]} failed: HTTP ${response.status}, codes ${codes}. Queue operations require Account > Queues > Edit (API Queues Write) or supported Workers Scripts Write. D1 operations require D1 Edit. Account scope: ${PRODUCTION_ACCOUNT}.`);
    }
    return data.result;
  };
}
export type CloudflareQueue = { queue_id: string; queue_name: string };
export async function findQueue(api: CfRequest, name: string) {
  const queues = await api<CloudflareQueue[]>(`/queues?name=${encodeURIComponent(name)}`);
  return queues.find(queue => queue.queue_name === name);
}
