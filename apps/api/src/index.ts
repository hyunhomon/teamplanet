import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { D1Database } from "@cloudflare/workers-types";

export type Bindings = { DB: D1Database };
export const app = new Hono<{ Bindings: Bindings }>();

app.use("*", secureHeaders());
app.use("/v1/*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  await next();
});

app.get("/v1/health", async context => {
  try {
    // Read no student data; also verify the initial schema has been migrated.
    await context.env.DB.prepare("SELECT 1 FROM assessments LIMIT 0").all();
    return context.json({ service: "teamplanet-api", status: "ok" });
  } catch {
    return context.json({ service: "teamplanet-api", status: "unavailable" }, 503);
  }
});

app.notFound(context => context.json({ error: { code: "NOT_FOUND" } }, 404));
app.onError((_error, context) => context.json({ error: { code: "INTERNAL_SERVER_ERROR" } }, 500));

export default app;
