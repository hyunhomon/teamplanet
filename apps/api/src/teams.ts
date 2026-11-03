import { Hono } from "hono";
import { teamParamsSchema, type Team } from "@teamplanet/contracts";
import { apiError } from "./errors";
import { audit, owned, type ProtectedEnv } from "./guard";

type TeamRow = { id: string; course_id: string; workspace_id: string; channel_id: string; name: string; collection_status: Team["collectionStatus"] };

/** Example of the shared guard for #7: validate the ID, resolve ownership, audit, then answer. */
export function teamRoutes(now: () => number) {
  const routes = new Hono<ProtectedEnv>();

  routes.get("/teams/:teamId", async context => {
    const params = teamParamsSchema.safeParse({ teamId: context.req.param("teamId") });
    if (!params.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const { teamId } = params.data;
    const team = await owned<TeamRow>(context, "team", teamId);
    await audit(context, { action: "team.read", targetType: "team", targetId: teamId, result: team ? "succeeded" : "denied" }, now).run();
    if (!team) return apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
    return context.json({
      id: team.id, courseId: team.course_id, workspaceId: team.workspace_id,
      channelId: team.channel_id, name: team.name, collectionStatus: team.collection_status,
    } satisfies Team, 200);
  });

  return routes;
}
