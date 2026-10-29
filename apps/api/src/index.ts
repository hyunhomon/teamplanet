import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import { authRoutes, defaultAuthDeps, type AuthDeps } from "./auth";
import { consentRoutes } from "./consents";
import { courseRoutes } from "./courses";
import { eventRoutes } from "./events";
import { apiError } from "./errors";
import { requireSession, type ProtectedEnv } from "./guard";
import { slackRoutes, type SlackBindings, type SlackFetch } from "./slack";
import { teamRoutes } from "./teams";
import type { MailBindings } from "./mailer";

export type Bindings = { DB: D1Database; WORK_QUEUE: Queue<QueueEnvelope>; SLACK_SIGNING_SECRET?: string } & MailBindings & SlackBindings;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function createApp(authDeps: AuthDeps = defaultAuthDeps, slackFetch: SlackFetch = (url, init) => fetch(url, init)) {
  const app = new Hono<{ Bindings: Bindings; Variables: ProtectedEnv["Variables"] }>();

  app.use("*", secureHeaders());
  app.use("/v1/*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  // Browser state changes must come from the page's own origin. Slack Events carry a signature instead (events.ts).
  app.use("/v1/*", async (context, next) => {
    if (!safeMethods.has(context.req.method) && context.req.path !== "/v1/slack/events"
      && context.req.header("Origin") !== new URL(context.req.url).origin) {
      return apiError(context, "FORBIDDEN", "허용되지 않은 요청 출처입니다.");
    }
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
  app.use("/v1/*", requireSession(authDeps.now));
  app.route("/v1/auth", authRoutes(authDeps));
  app.route("/v1", courseRoutes(authDeps.now));
  app.route("/v1", teamRoutes(authDeps.now, slackFetch));
  app.route("/v1", slackRoutes(authDeps.now, slackFetch));
  app.route("/v1", consentRoutes(authDeps.now, slackFetch));
  app.route("/v1", eventRoutes(authDeps.now));

  app.notFound(context => apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다."));
  app.onError((_error, context) => apiError(context, "INTERNAL_SERVER_ERROR", "요청을 처리하지 못했습니다."));
  return app;
}

export const app = createApp();
export default app;
