import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { analysisRoutes } from "../apps/api/src/analysis";
import type { ProtectedEnv } from "../apps/api/src/guard";
import { collectionFixture } from "./helpers/collection";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { analysisRunResponseSchema, jobKey, type QueueEnvelope } from "@teamplanet/contracts";
import { prepareRun, withChunkInput } from "@teamplanet/analysis";
import { JobStore, LeaseLost, consumeMessage, type JobContext } from "@teamplanet/queue";
import { createHandlers } from "../apps/consumer/src/index";
import { purgeTeam, requestErasure, withMessageImages } from "@teamplanet/collection";
let f: Awaited<ReturnType<typeof collectionFixture>>, app: Hono<ProtectedEnv>, clock: number, professor: (typeof fixtures.professors)[number];
let send: (url: string, init: RequestInit) => Promise<Response>;
beforeEach(async () => {
  f = await collectionFixture(); clock = f.now(); professor = f.professor;
  f.sqlite.run("INSERT INTO course_rubric_settings VALUES (?, 'communication-v1', '[\"clarity\"]', 1)", [f.course.id]);
  f.sqlite.run("INSERT INTO collection_coverage (request_id, team_id, from_ms, to_ms, status, started_at, updated_at) VALUES (?, ?, ?, ?, 'complete', ?, ?)", [crypto.randomUUID(), f.teamId, f.start, f.start + 200000, clock, clock]);
  app = new Hono<ProtectedEnv>(); app.use("*", async (c, next) => { c.set("professor", professor); await next(); }); app.route("/", analysisRoutes(() => clock));
  send = async () => Response.json({ ok: true, messages: [{ ts: f.slackTs, user: f.userId, text: f.text }], has_more: false });
});
afterEach(() => f.sqlite.close());
const request = () => ({ teamId: f.teamId, from: new Date(f.start).toISOString(), to: new Date(f.start + 200000).toISOString(), timezone: "Asia/Seoul", idempotencyKey: crypto.randomUUID() });
const call = (path: string, body?: unknown, env?: any) => app.request(`https://synthetic${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env ?? { DB: f.db });
async function create(body = request(), env?: any) { const response = await call("/analysis-runs", body, env); expect(response.status).toBe(202); return analysisRunResponseSchema.parse(await response.json()); }
const deps = () => ({ db: f.db, now: () => clock, send, tokenKey: f.tokenKey });
async function context(runId: string): Promise<JobContext> {
  const store = new JobStore(f.db, () => clock), key = jobKey({ kind: "analysis.prepare", runId });
  const lease = (await store.claim(key, 0))!;
  return { heartbeat: () => store.heartbeat(lease), checkpoint: name => store.checkpoint(key, name), commit: (name, ref, writes) => store.commit(lease, name, ref, writes) };
}
test("concurrent/retried create is one run+outbox; send failure remains durably queued; new request creates a version", async () => {
  const body = request(); let sends = 0;
  const env = { DB: f.db, WORK_QUEUE: { send: async () => { sends++; throw new Error("synthetic"); } } };
  const [a, b] = await Promise.all([create(body, env), create(body, env)]);
  expect(a.id).toBe(b.id); expect(sends).toBe(1);
  expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toHaveLength(1);
  expect(f.sqlite.query("SELECT * FROM queue_jobs").all()).toHaveLength(1);
  expect((await call("/analysis-runs", { ...body, timezone: "UTC" })).status).toBe(409);
  const newer = await create(); expect(newer.version).toBe(2); expect(newer.id).not.toBe(a.id);
});
test("owner, timezone, actual course period, incomplete settings/coverage and transactional enqueue failure are enforced", async () => {
  professor = fixtures.professors[1]!; expect((await call("/analysis-runs", request())).status).toBe(404); professor = f.professor;
  expect((await call("/analysis-runs", { ...request(), timezone: "Fake/Zone" })).status).toBe(400);
  expect((await call("/analysis-runs", { ...request(), to: new Date(clock + 1).toISOString() })).status).toBe(409);
  f.sqlite.run("DELETE FROM collection_coverage"); expect((await call("/analysis-runs", request())).status).toBe(409);
  f.sqlite.run("INSERT INTO collection_coverage (request_id, team_id, from_ms, to_ms, status, started_at, updated_at) VALUES (?, ?, ?, ?, 'complete', ?, ?)", [crypto.randomUUID(), f.teamId, f.start, f.start + 200000, clock, clock]);
  f.sqlite.run("CREATE TRIGGER synthetic_enqueue_failure BEFORE INSERT ON queue_jobs BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  expect((await call("/analysis-runs", request())).status).toBe(409);
  expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toEqual([]); expect(f.sqlite.query("SELECT * FROM analysis_specs").all()).toEqual([]);
});
test("prepare stores references only, restores chunk input in memory and never marks an unregistered model handler complete", async () => {
  const run = await create(); await prepareRun(deps(), run.id, await context(run.id));
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.status).toBe("evidence_extraction"); expect(state.valid).toBe(true); expect(state.manifest?.sourceCount).toBe(1); expect(state.manifest?.chunkCount).toBe(1);
  let retained: any;
  await withChunkInput(deps(), run.id, "chunk_0", async (input, check) => { retained = input; expect(input.parts[0]!.text).toBe(f.text); await check(); });
  expect(retained.parts[0].text).toBe("");
  const stored = JSON.stringify([f.sqlite.query("SELECT * FROM analysis_sources").all(), f.sqlite.query("SELECT * FROM analysis_specs").all(), f.sqlite.query("SELECT * FROM job_checkpoints").all()]);
  expect(stored).not.toContain(f.text); expect(stored).not.toContain("data:image"); expect(stored).not.toContain("xoxb");
  const envelope: QueueEnvelope = { version: 1, generation: 0, job: { kind: "analysis.stage", runId: run.id, stage: "evidence_extraction", chunkId: "chunk_0" } };
  await consumeMessage({ id: "synthetic", body: envelope, attempts: 1, ack() {}, retry() {} }, new JobStore(f.db, () => clock), { send: async () => {} } as any, createHandlers(f.db, () => clock));
  const waiting = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(waiting.errors.some(e => e.code === "HANDLER_UNREGISTERED")).toBe(true); expect(waiting.progress.completedChunks).toBe(0);
  expect((await call(`/analysis-runs/${run.id}/resume`, {})).status).toBe(202);
});
test("server interruption preserves checkpoints; restart cannot promote a withdrawn or cancelled run", async () => {
  const run = await create(), ctx = await context(run.id); let interrupt = true;
  await expect(prepareRun(deps(), run.id, { ...ctx, heartbeat: async () => { if (interrupt) { interrupt = false; throw new LeaseLost(); } } })).rejects.toThrow();
  expect((f.sqlite.query("SELECT status FROM analysis_runs").get() as any).status).toBe("collecting");
  clock += 61000;
  await prepareRun(deps(), run.id, await context(run.id));
  expect(analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json()).valid).toBe(true);
  f.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = ?", [clock]);
  const invalid = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json()); expect(invalid.valid).toBe(false); expect(invalid.manifest).toBeNull();
  await expect(withChunkInput(deps(), run.id, "chunk_0", async () => {})).rejects.toThrow();
  expect((await call(`/analysis-runs/${run.id}/resume`, {})).status).toBe(409);
});
test("cancellation fences in-flight prepare and unrelated professor reads; erase cleans all new run tables", async () => {
  const run = await create(); const ctx = await context(run.id);
  await call(`/analysis-runs/${run.id}/cancel`, {});
  await expect(prepareRun(deps(), run.id, ctx)).rejects.toThrow();
  expect((await call(`/analysis-runs/${run.id}/resume`, {})).status).toBe(409);
  professor = fixtures.professors[1]!; expect((await call(`/analysis-runs/${run.id}`)).status).toBe(404); professor = f.professor;
  await requestErasure(f.db, f.teamId, "request", clock); await purgeTeam(f.db, f.teamId, clock);
  expect(f.sqlite.query("SELECT * FROM analysis_specs").all()).toEqual([]); expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toEqual([]);
});
test("remote edits invalidate old source without inventing a deletion; a fresh run can use the new revision", async () => {
  const old = await create(); await prepareRun(deps(), old.id, await context(old.id));
  send = async () => Response.json({ ok: true, messages: [{ ts: f.slackTs, user: f.userId, text: `${f.text} (합성 수정)`, edited: { ts: `${Math.floor(f.start / 1000) + 150}.000000` } }], has_more: false });
  await expect(withChunkInput(deps(), old.id, "chunk_0", async () => {})).rejects.toThrow();
  await expect(withMessageImages(deps(), f.target, async () => {})).rejects.toThrow("SOURCE_CHANGED");
  expect((f.sqlite.query("SELECT deleted_at FROM message_refs").get() as any).deleted_at).toBeNull();
  const newer = await create(); await prepareRun(deps(), newer.id, await context(newer.id));
  expect(analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${newer.id}`)).json()).valid).toBe(true);
  expect(analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${old.id}`)).json()).valid).toBe(false);
});
