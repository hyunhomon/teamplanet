import { Hono } from "hono";
import { collectionFixture } from "./collection";
import { analysisRoutes } from "../../apps/api/src/analysis";
import { resultRoutes } from "../../apps/api/src/results";
import type { ProtectedEnv } from "../../apps/api/src/guard";
import { analysisArtifactsSchema, analysisRunResponseSchema, jobKey, type NormalizedEvidence } from "@teamplanet/contracts";
import { prepareRun, withChunkInput, reconcileReview, loadSpec, analysisId } from "@teamplanet/analysis";
import { sha256Hex } from "@teamplanet/collection";
import { JobStore } from "@teamplanet/queue";
/** Fully synthetic result on real migrations/source fences. No external service or student data. */
export async function resultFixture(messageCount = 1) {
  const f = await collectionFixture(); let clock = f.now(), professor = f.professor, outage = false, changed = false, deleted = false;
  const messages = Array.from({ length: messageCount }, (_, i) => ({ ts: i === 0 ? f.slackTs : `${Math.floor(Number(f.slackTs)) + i}.000000`, user: f.userId,
    text: i === 0 ? f.text : `합성 스레드 응답 ${i}`, ...(messageCount > 1 ? { thread_ts: f.slackTs, ...(i === 0 ? { reply_count: messageCount - 1 } : {}) } : {}) }));
  const send = async () => {
    if (outage) return Response.json({ ok: false, error: "ratelimited" });
    return Response.json({ ok: true, messages: deleted ? [] : messages.map((m,i) => changed && i === 0 ? { ...m, text: f.text + " changed" } : m), has_more: false });
  };
  const deps = () => ({ db: f.db, now: () => clock, send, tokenKey: f.tokenKey });
  f.sqlite.run("INSERT INTO course_rubric_settings VALUES (?, 'communication-v1', '[\"clarity\"]', 1)", [f.course.id]);
  f.sqlite.run("INSERT INTO collection_coverage (request_id,team_id,from_ms,to_ms,status,started_at,updated_at) VALUES (?,?,?,?,'complete',?,?)", [crypto.randomUUID(), f.teamId, f.start, f.start + 200000, clock, clock]);
  const app = new Hono<ProtectedEnv>(); app.use("*", async (c, next) => { c.set("professor", professor); await next(); });
  app.route("/v1", analysisRoutes(() => clock, send)); app.route("/v1", resultRoutes(() => clock, send));
  const env = { DB: f.db, SLACK_TOKEN_KEY: f.tokenKey };
  const call = (path: string, body?: unknown) => app.request(`https://synthetic/v1/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const run = analysisRunResponseSchema.parse(await (await call("analysis-runs", { teamId: f.teamId, from: new Date(f.start).toISOString(), to: new Date(f.start + 200000).toISOString(), timezone: "Asia/Seoul", idempotencyKey: crypto.randomUUID() })).json());
  const store = new JobStore(f.db, () => clock), lease = (await store.claim(jobKey({ kind: "analysis.prepare", runId: run.id }), 0))!;
  await prepareRun(deps(), run.id, { heartbeat: () => store.heartbeat(lease), checkpoint: name => store.checkpoint(jobKey({ kind: "analysis.prepare", runId: run.id }), name), commit: (name, ref, writes) => store.commit(lease, name, ref, writes) });
  const artifacts = await withChunkInput(deps(), run.id, "chunk_0", async source => {
    const p = source.parts[0]!, e: NormalizedEvidence = { id: await analysisId("evidence", run.id), messageIds: [p.messageId], actorIds: [p.studentId], summary: "합성 프로젝트의 설명 사례이다.", behaviorTags: ["clarity"], modality: "text",
      citations: [{ messageId: p.messageId, start: p.start, end: p.end, hash: await sha256Hex(p.text) }], imageIds: [], limitations: ["단일 합성 관찰"], requiresHumanReview: true };
    const { chunkId, primaryPartIds, ...context } = source;
    const assessment = { version: source.version, runId: run.id, overviews: [{ studentId: p.studentId, summary: "관찰 범위를 확인해야 한다.", limitations: ["단일 관찰"], requiresHumanReview: true }],
      assessments: [{ studentId: p.studentId, key: "clarity", judgement: "observed_strength", narrative: "설명 발화가 관찰됐다.", evidenceIds: [e.id], counterEvidenceIds: [], confidence: "medium", limitations: ["단일 관찰"], requiresHumanReview: true }] };
    const review = { version: source.version, runId: run.id, iteration: 0, decision: "accept", issues: [], limitations: [], requiresHumanReview: true };
    const receipt = { generationId: "gen-synthetic-result", model: "qwen/qwen3.5-9b", provider: "DeepInfra", requestedProvider: "deepinfra/bf16", promptVersion: "communication-prompts-v1" };
    f.sqlite.run("INSERT INTO analysis_stage_results VALUES (?, 'evidence_extraction', 'chunk_0', 0, ?, ?, ?, ?, ?)", [run.id, JSON.stringify({ runId: run.id, chunkId, processedPartIds: primaryPartIds, events: [e], limitations: [], missingImageIds: [], receipt }), receipt.model, receipt.provider, receipt.promptVersion, clock]);
    const spec = (await loadSpec(f.db, run.id))!;
    const input = { ...context, limitations: JSON.parse(spec.manifest_json!).limitations, evidence: [e], correction: null, assessment, iteration: 0 };
    const history = await reconcileReview(input, review);
    return analysisArtifactsSchema.parse({ version: "analysis-output-v1", runId: run.id, snapshot: JSON.parse(spec.snapshot_json), manifest: JSON.parse(spec.manifest_json!),
      evidence: [e], originalAssessment: history.originalAssessment, firstReview: history.firstReview, correction: null, finalReview: history.finalReview, candidate: history.candidate,
      requiresHumanReview: history.requiresHumanReview, receipts: [receipt] });
  });
  f.sqlite.run("INSERT INTO analysis_outputs VALUES (?, ?, ?)", [run.id, JSON.stringify(artifacts), clock]);
  f.sqlite.run("UPDATE analysis_runs SET status = 'awaiting_professor' WHERE id = ?", [run.id]);
  return { ...f, app, env, call, run, artifacts, deps, now: () => clock, setClock: (value: number) => { clock = value; },
    setProfessor: (value: typeof professor) => { professor = value; }, outage: () => { outage = true; }, edit: () => { changed = true; }, deleteSource: () => { deleted = true; } };
}
