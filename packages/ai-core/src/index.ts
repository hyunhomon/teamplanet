/** Minimal OpenRouter adapter contracts. Deliberately no app cost-budget guards. */
import { providerPolicy } from "./model-policy";
export { modelProfile, providerPolicy } from "./model-policy";
export type ModelRole = "evidence" | "assessor" | "reviewer";

export function getModelIds(env: Record<string, string | undefined>): Record<ModelRole, string> {
  const names = {
    evidence: env.OPENROUTER_MODEL_EVIDENCE,
    assessor: env.OPENROUTER_MODEL_ASSESSOR,
    reviewer: env.OPENROUTER_MODEL_REVIEWER,
  };
  for (const [role, id] of Object.entries(names)) {
    if (!id?.trim()) throw new Error(`Missing OpenRouter model ID for ${role}`);
  }
  return names as Record<ModelRole, string>;
}

export type BillingBlock = {
  code: "OPENROUTER_BILLING_BLOCKED";
  providerStatus: 402;
  kind: "insufficient_credits" | "key_limit_exhausted" | "in_flight_budget" | "unspecified_provider_billing";
  source?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
};

/** Call only for real HTTP 402 from OpenRouter; never preflight an estimated cost. */
export function parseOpenRouter402(
  status: number,
  body: unknown,
  retryAfterHeader: string | null = null,
): BillingBlock | null {
  if (status !== 402) return null;
  const obj = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  const err = typeof obj.error === "object" && obj.error !== null ? obj.error as Record<string, unknown> : {};
  const metadata = typeof err.metadata === "object" && err.metadata !== null ? err.metadata as Record<string, unknown> : {};
  const source = typeof metadata.limit_source === "string" ? metadata.limit_source : undefined;
  const kind = source === "openrouter_credits" ? "insufficient_credits"
    : source === "openrouter_key_limit" ? "key_limit_exhausted"
    : source === "openrouter_in_flight_budget" ? "in_flight_budget"
    : "unspecified_provider_billing";
  // OpenRouter in-flight spending 402 can have Retry-After. Treat as transient only when explicit.
  const seconds = retryAfterHeader && /^\d+$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader) : undefined;
  return {
    code: "OPENROUTER_BILLING_BLOCKED", providerStatus: 402, kind, source,
    retryable: kind === "in_flight_budget" && seconds !== undefined,
    ...(seconds !== undefined ? { retryAfterSeconds: seconds } : {}),
  };
}

/** Minimal request helper; orchestration and Queue retries belong in the API worker. */
export async function requestOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<Record<string, unknown>>,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
) {
  const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, provider: providerPolicy, reasoning: { enabled: false } }),
  });
  const rawBody = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Preserve HTTP failures even when a gateway returns HTML or an empty body.
    const block = parseOpenRouter402(res.status, null, res.headers.get("Retry-After"));
    if (block) return { ok: false as const, error: block };
    return {
      ok: false as const,
      error: {
        code: res.ok ? "OPENROUTER_INVALID_RESPONSE" : "OPENROUTER_REQUEST_ERROR",
        providerStatus: res.status,
        details: rawBody,
      },
    };
  }
  const block = parseOpenRouter402(res.status, payload, res.headers.get("Retry-After"));
  if (block) return { ok: false as const, error: block };
  const body = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : {};
  const failedChoice = Array.isArray(body.choices) && body.choices.some(
    choice => typeof choice === "object" && choice !== null
      && (choice.finish_reason === "error" || choice.error != null),
  );
  // OpenRouter may have already sent HTTP 200 before a provider fails.
  if (!res.ok || body.error != null || failedChoice) {
    return { ok: false as const, error: { code: "OPENROUTER_REQUEST_ERROR", providerStatus: res.status, details: payload } };
  }
  return { ok: true as const, data: payload };
}
