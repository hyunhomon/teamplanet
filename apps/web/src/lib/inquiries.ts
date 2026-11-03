import { apiErrorSchema } from "@teamplanet/contracts";
type Schema<T> = { parse(value: unknown): T };
export async function inquiryRequest<T>(path: string, schema: Schema<T>, body?: unknown, professor = false, method?: string,
  fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(`/v1${path}`, { method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: professor ? "same-origin" : "omit", cache: "no-store", signal: AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(data);
    throw new Error(response.status === 401 ? "로그인이 만료되었습니다. 다시 로그인하세요."
      : response.status === 404 ? "본인 링크를 확인하세요. 만료된 문의는 더 이상 조회할 수 없습니다."
      : response.status === 409 ? "처리 상태나 기한이 변경되었습니다. 최신 안내를 다시 조회하세요."
      : error.success && response.status === 400 ? "입력 내용을 확인하세요." : "요청을 완료하지 못했습니다. 다시 조회하세요.");
  }
  return schema.parse(data);
}
