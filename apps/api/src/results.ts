import { Hono, type Context } from "hono";
import { resultResponseSchema, evidenceResponseSchema, messageContextSchema, resultEvidenceParamsSchema, runIdSchema, sourceIdSchema, type Part } from "@teamplanet/contracts";
import { withVerifiedArtifacts, withSourceParts } from "@teamplanet/analysis";
import { SourceUnavailable, sha256Hex, type ImageDeps } from "@teamplanet/collection";
import { owned, type ProtectedEnv } from "./guard";
import { apiError } from "./errors";
type Env = { Bindings: ProtectedEnv["Bindings"] & { SLACK_TOKEN_KEY?: string }; Variables: ProtectedEnv["Variables"] };
export const resultFailure = (c: Context, error: unknown) => error instanceof SourceUnavailable && error.code === "SLACK_UNAVAILABLE"
  ? apiError(c, "SLACK_UNAVAILABLE", "Slack 원문을 재검증하지 못했습니다. 삭제로 판단하지 않았습니다.", { retryable: error.retryable })
  : apiError(c, "CONFLICT", "결과나 근거가 무효이거나 검증되지 않았습니다. 새 분석과 교수 재검토가 필요합니다.");
export function resultRoutes(now: () => number, send: ImageDeps["send"]) {
  const routes = new Hono<Env>();
  const deps = (c: Context<Env>): ImageDeps => ({ db: c.env.DB, now, send, tokenKey: c.env.SLACK_TOKEN_KEY });
  const missing = (c: Context) => apiError(c, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
  routes.get("/analysis-runs/:id/assessments", async c => {
    const id = runIdSchema.safeParse(c.req.param("id")); if (!id.success) return apiError(c, "VALIDATION_ERROR", "실행 ID를 확인하세요.");
    if (!await owned(c, "run", id.data)) return missing(c);
    try { return await withVerifiedArtifacts(deps(c), id.data, async (artifacts, input, spec, current) => {
      const artifactHash = await sha256Hex(JSON.stringify(artifacts)); await current();
      return c.json(resultResponseSchema.parse({ runId: id.data, teamId: spec.team_id, status: spec.status, version: spec.version, from: spec.from_ts, to: spec.to_ts,
        verifiedAt: new Date(now()).toISOString(), artifactHash, students: input.students, artifacts }));
    }); } catch (error) { return resultFailure(c, error); }
  });
  routes.get("/analysis-runs/:id/evidence/:evidenceId", async c => {
    const params = resultEvidenceParamsSchema.safeParse(c.req.param()); if (!params.success) return apiError(c, "VALIDATION_ERROR", "근거 ID를 확인하세요.");
    if (!await owned(c, "run", params.data.id)) return missing(c);
    try { return await withVerifiedArtifacts(deps(c), params.data.id, async (artifacts, _input, _spec, current) => {
      const evidence = artifacts.evidence.find(e => e.id === params.data.evidenceId); if (!evidence) return missing(c);
      await current(); return c.json(evidenceResponseSchema.parse({ runId: params.data.id, verifiedAt: new Date(now()).toISOString(), evidence }));
    }); } catch (error) { return resultFailure(c, error); }
  });
  routes.get("/analysis-runs/:id/messages/:messageId", async c => {
    const id = runIdSchema.safeParse(c.req.param("id")), messageId = sourceIdSchema.safeParse(c.req.param("messageId"));
    const after = c.req.query("after"), cursor = after === undefined ? null : sourceIdSchema.safeParse(after);
    if (!id.success || !messageId.success || cursor && !cursor.success) return apiError(c, "VALIDATION_ERROR", "원문 ID나 페이지를 확인하세요.");
    if (!await owned(c, "run", id.data)) return missing(c);
    try { return await withVerifiedArtifacts(deps(c), id.data, async (_artifacts, input, spec, current) => {
      const rows = await c.env.DB.prepare("SELECT id,slack_ts,parts_json,attachments_json FROM analysis_sources WHERE run_id = ? ORDER BY slack_ts").bind(id.data).all<any>();
      const target = rows.results.find(r => r.id === messageId.data); if (!target) return missing(c);
      const root = (JSON.parse(target.parts_json) as Part[])[0]?.threadId ?? target.id;
      const thread = rows.results.filter(r => r.id === root || (JSON.parse(r.parts_json) as Part[]).some(p => p.threadId === root));
      const afterIndex = cursor?.success ? thread.findIndex(r => r.id === cursor.data) : -1;
      if (cursor && afterIndex < 0) return missing(c);
      const page = thread.slice(afterIndex + 1, afterIndex + 21), nextAfter = thread.length > afterIndex + 21 ? page.at(-1)!.id : null;
      const wanted = page.flatMap(r => JSON.parse(r.parts_json) as Part[]);
      return withSourceParts(deps(c), spec, wanted, async (parts, pageCurrent) => {
        const messages = page.map(row => {
          const segments = parts.filter(p => p.messageId === row.id).sort((a,b) => a.start - b.start), first = segments[0]!;
          let text = ""; for (const p of segments) if (p.end > text.length) text += p.text.slice(Math.max(0, text.length - p.start));
          return { id: row.id, studentId: first.studentId, displayName: input.students.find(s => s.id === first.studentId)!.displayName, sentAt: first.sentAt, text,
            limitations: [...new Set(segments.flatMap(p => p.limitations))], images: (JSON.parse(row.attachments_json) as any[]).map(a => ({ id: a.id, available: false as const,
              limitations: [a.limitation ?? "image_not_embedded_use_authorized_slack"] })) };
        });
        await pageCurrent(); await current();
        return c.json(messageContextSchema.parse({ runId: id.data, targetId: messageId.data, verifiedAt: new Date(now()).toISOString(), messages, nextAfter,
          limitations: ["only_authorized_run_period_context", ...(thread.some(r => r.id === root) ? [] : ["thread_root_outside_authorized_period"])] }));
      }, { metadataImages: true });
    }); } catch (error) { return resultFailure(c, error); }
  });
  return routes;
}
