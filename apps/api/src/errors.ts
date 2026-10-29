import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { apiErrorStatus, type ApiError, type ApiErrorCode } from "@teamplanet/contracts";

type Extra = Partial<Pick<ApiError["error"], "retryable" | "issues" | "retryAfterSeconds">>;

/** Common error envelope. Never pass request input, OTPs, tokens or SQL into `message`. */
export function apiError(context: Context, code: ApiErrorCode, message: string, extra: Extra = {}) {
  const body: ApiError = { error: { code, message, requestId: `request_${crypto.randomUUID()}`, retryable: false, ...extra } };
  if (extra.retryAfterSeconds !== undefined) context.header("Retry-After", String(extra.retryAfterSeconds));
  return context.json(body, apiErrorStatus[code] as ContentfulStatusCode);
}

type Schema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
};
/** JSON body through a shared contract schema; malformed JSON and schema failures are both 400. */
export async function parseBody<T>(context: Context, schema: Schema<T>) {
  let body: unknown;
  try { body = await context.req.json(); } catch { body = undefined; }
  const result = schema.safeParse(body);
  if (result.success) return { data: result.data };
  const issues = result.error.issues.map(issue => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"), message: issue.message,
  }));
  return { error: apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.", { issues }) };
}
