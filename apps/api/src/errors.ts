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
