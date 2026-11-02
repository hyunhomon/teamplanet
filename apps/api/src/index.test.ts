import { expect, test } from "bun:test";
import { app, type Bindings } from "./index";
import { apiErrorSchema } from "@teamplanet/contracts";

app.get("/test-internal-error", () => { throw new Error("private database error details"); });

function database(fail = false): Bindings {
  return { DB: {
    prepare: () => ({ all: async () => {
      if (fail) throw new Error("private database error details");
      return { results: [] };
    } }),
  } } as unknown as Bindings;
}

test("health checks database readiness without returning records", async () => {
  const response = await app.request("/v1/health", {}, database());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ service: "teamplanet-api", status: "ok" });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("database failure is an unavailable response without internal details", async () => {
  const response = await app.request("/v1/health", {}, database(true));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ service: "teamplanet-api", status: "unavailable" });
});

test("unknown endpoints use the common 404 envelope", async () => {
  const response = await app.request("/v1/auth/not-a-route", {}, database());
  expect(response.status).toBe(404);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe("NOT_FOUND");
  expect(body.error.retryable).toBe(false);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("unexpected errors use the common envelope and hide internal details", async () => {
  const response = await app.request("/test-internal-error", {}, database());
  expect(response.status).toBe(500);
  const body = apiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  expect(JSON.stringify(body)).not.toContain("private database");
});
