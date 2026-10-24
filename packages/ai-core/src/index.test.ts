import { describe, expect, test } from "bun:test";
import { parseOpenRouter402, requestOpenRouter } from "./index";

function requestWith(response: Response) {
  return requestOpenRouter("test-key", "test-model", [], async () => response);
}

describe("requestOpenRouter", () => {
  test("returns a successful completion", async () => {
    const data = { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
    expect(await requestWith(Response.json(data))).toEqual({ ok: true, data });
  });

  test("rejects a provider error inside HTTP 200", async () => {
    const details = { error: { code: 502, message: "Provider unavailable" } };
    expect(await requestWith(Response.json(details))).toEqual({
      ok: false,
      error: { code: "OPENROUTER_REQUEST_ERROR", providerStatus: 200, details },
    });
  });

  test("rejects partial output terminated by a provider error", async () => {
    const details = {
      choices: [{
        message: { content: "partial output" },
        finish_reason: "error",
        error: { code: 502, message: "Provider disconnected" },
      }],
    };
    const result = await requestWith(Response.json(details));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.providerStatus).toBe(200);
  });

  test("preserves HTTP status and body for an HTML gateway error", async () => {
    const details = "<html>Bad Gateway</html>";
    expect(await requestWith(new Response(details, { status: 502 }))).toEqual({
      ok: false,
      error: { code: "OPENROUTER_REQUEST_ERROR", providerStatus: 502, details },
    });
  });

  test("preserves HTTP status for an empty rate-limit response", async () => {
    expect(await requestWith(new Response(null, { status: 429 }))).toEqual({
      ok: false,
      error: { code: "OPENROUTER_REQUEST_ERROR", providerStatus: 429, details: "" },
    });
  });

  test("classifies a non-JSON 402 as an unspecified billing block", async () => {
    const result = await requestWith(new Response("Payment Required", { status: 402 }));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "OPENROUTER_BILLING_BLOCKED",
        providerStatus: 402,
        kind: "unspecified_provider_billing",
        retryable: false,
      },
    });
  });

  test("classifies a successful response with invalid JSON as invalid", async () => {
    expect(await requestWith(new Response("not JSON"))).toEqual({
      ok: false,
      error: { code: "OPENROUTER_INVALID_RESPONSE", providerStatus: 200, details: "not JSON" },
    });
  });

  test("retains JSON HTTP error details", async () => {
    const details = { error: { code: 401, message: "Invalid key" } };
    expect(await requestWith(Response.json(details, { status: 401 }))).toEqual({
      ok: false,
      error: { code: "OPENROUTER_REQUEST_ERROR", providerStatus: 401, details },
    });
  });

  test("retains transient billing classification and retry delay", async () => {
    const result = await requestWith(Response.json({
      error: { metadata: { limit_source: "openrouter_in_flight_budget" } },
    }, { status: 402, headers: { "Retry-After": "30" } }));
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "in_flight_budget", retryable: true, retryAfterSeconds: 30 },
    });
  });
});

describe("parseOpenRouter402", () => {
  test.each([
    ["openrouter_credits", "insufficient_credits"],
    ["openrouter_key_limit", "key_limit_exhausted"],
  ])("does not retry %s", (source, kind) => {
    expect(parseOpenRouter402(402, { error: { metadata: { limit_source: source } } }, "30"))
      .toMatchObject({ kind, retryable: false });
  });

  test("requires an explicit delay before retrying an in-flight block", () => {
    const body = { error: { metadata: { limit_source: "openrouter_in_flight_budget" } } };
    expect(parseOpenRouter402(402, body)).toMatchObject({ retryable: false });
    expect(parseOpenRouter402(402, body, "invalid")).toMatchObject({ retryable: false });
    expect(parseOpenRouter402(429, body, "30")).toBeNull();
  });
});
