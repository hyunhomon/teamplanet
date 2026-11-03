import { Hono } from "hono";
import { dataStatusSchema, erasureRequestSchema, erasureRetrySchema, invalidationRequestSchema, teamParamsSchema } from "@teamplanet/contracts";
import { invalidateTeam, requestErasure } from "@teamplanet/collection";
import { audit, owned, type ProtectedEnv } from "./guard";
import { apiError, parseBody } from "./errors";

export function lifecycleRoutes(now: () => number) {
  const routes = new Hono<ProtectedEnv>();
  const paths = ["/teams/:teamId/data-status", "/teams/:teamId/data-erasure", "/teams/:teamId/data-erasure/retry", "/teams/:teamId/data-invalidation"];
  for (const path of paths) routes.use(path, async (context, next) => {
    const params = teamParamsSchema.safeParse({ teamId: context.req.param("teamId") });
    if (!params.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(context, "team", params.data.teamId)) return apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    await next();
  });
  async function status(db: ProtectedEnv["Bindings"]["DB"], teamId: string) {
    const version = (await db.prepare("SELECT * FROM team_data_versions WHERE team_id = ?").bind(teamId).first<any>())!;
    const job = await db.prepare("SELECT * FROM data_erasure_jobs WHERE team_id = ?").bind(teamId).first<any>();
    const count = await db.prepare("SELECT COUNT(*) AS n FROM run_data_validity WHERE team_id = ? AND invalidated_at IS NOT NULL").bind(teamId).first<{ n: number }>();
    return dataStatusSchema.parse({ teamId, epoch: version.epoch, blockedAt: version.blocked_at === null ? null : new Date(version.blocked_at).toISOString(),
      purgedAt: version.purged_at === null ? null : new Date(version.purged_at).toISOString(), invalidatedRuns: count!.n,
      erasure: job ? { id: job.id, status: job.status, attempts: job.attempts, completedAt: job.completed_at === null ? null : new Date(job.completed_at).toISOString(), errorCode: job.error_code } : null });
  }
  routes.get("/teams/:teamId/data-status", async c => c.json(await status(c.env.DB, c.req.param("teamId"))));
  routes.post("/teams/:teamId/data-erasure", async c => {
    const input = await parseBody(c, erasureRequestSchema); if (input.error) return input.error;
    const teamId = c.req.param("teamId");
    await requestErasure(c.env.DB, teamId, "request", now(), [audit(c, { action: "data.erasure_request", targetType: "team", targetId: teamId, result: "succeeded" }, now)]);
    return c.json(await status(c.env.DB, teamId), 202);
  });
  routes.post("/teams/:teamId/data-erasure/retry", async c => {
    const input = await parseBody(c, erasureRetrySchema); if (input.error) return input.error;
    const teamId = c.req.param("teamId");
    const failed = await c.env.DB.prepare("SELECT 1 FROM data_erasure_jobs WHERE team_id = ? AND status = 'failed'").bind(teamId).first();
    if (!failed) return apiError(c, "CONFLICT", "재시도할 실패한 삭제 작업이 없습니다.");
    await c.env.DB.batch([c.env.DB.prepare("UPDATE data_erasure_jobs SET status = 'pending', attempts = 0, next_attempt_at = 0 WHERE team_id = ? AND status = 'failed'").bind(teamId),
      audit(c, { action: "data.erasure_retry", targetType: "team", targetId: teamId, result: "succeeded" }, now)]);
    return c.json(await status(c.env.DB, teamId), 202);
  });
  routes.post("/teams/:teamId/data-invalidation", async c => {
    const input = await parseBody(c, invalidationRequestSchema); if (input.error) return input.error;
    const teamId = c.req.param("teamId");
    await c.env.DB.batch([invalidateTeam(c.env.DB, teamId, input.data.reason, now()), audit(c, { action: "data.invalidate", targetType: "team", targetId: teamId, result: "succeeded" }, now)]);
    return c.json(await status(c.env.DB, teamId));
  });
  return routes;
}
