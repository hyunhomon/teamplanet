import { expect, test } from "bun:test";
import { app, type Bindings } from "./index";

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

test("unimplemented endpoints do not pretend to authenticate or collect data", async () => {
  const response = await app.request("/v1/auth/otp/request", { method: "POST" }, database());
  expect(response.status).toBe(404);
});
