import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { ApiError, QueueEnvelope } from "@teamplanet/contracts";

export type Bindings = { DB: D1Database; WORK_QUEUE: Queue<QueueEnvelope> };
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

const errorBody = (code: "NOT_FOUND" | "INTERNAL_SERVER_ERROR", message: string): ApiError => ({
  error: { code, message, requestId: `request_${crypto.randomUUID()}`, retryable: false },
});
app.notFound(context => context.json(errorBody("NOT_FOUND", "리소스를 찾을 수 없습니다."), 404));
app.onError((_error, context) => context.json(errorBody("INTERNAL_SERVER_ERROR", "요청을 처리하지 못했습니다."), 500));

export default app;
