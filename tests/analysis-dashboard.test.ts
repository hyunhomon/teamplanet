import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { analysisRoutes } from "../apps/api/src/analysis";
import type { ProtectedEnv } from "../apps/api/src/guard";
import { analysisDashboardSchema, analysisPreviewSchema, analysisRunListSchema, analysisRunResponseSchema } from "@teamplanet/contracts";
import { professors } from "@teamplanet/contracts/fixtures";
import { DashboardController } from "../apps/web/src/lib/analysis-dashboard";
import { collectionFixture } from "./helpers/collection";
import { createApp } from "../apps/api/src/index";
let f: Awaited<ReturnType<typeof collectionFixture>>, professor: (typeof professors)[number], clock: number;
let app: Hono<ProtectedEnv>;
beforeEach(async () => {
  f = await collectionFixture(); professor = f.professor; clock = f.now();
  f.sqlite.run("INSERT INTO course_rubric_settings VALUES (?, 'communication-v1', '[\"clarity\"]', 1)", [f.course.id]);
  f.sqlite.run("INSERT INTO collection_coverage (request_id, team_id, from_ms, to_ms, status, updated_at, started_at, limitations_json, excluded, old_thread_roots) VALUES (?, ?, ?, ?, 'complete', ?, ?, '[\"older_thread_replies_from_events_only\"]', 1, 2)",
    [crypto.randomUUID(), f.teamId, f.start, f.start + 200000, clock, clock]);
  app = new Hono<ProtectedEnv>(); app.use("*", async (c, next) => { c.set("professor", professor); await next(); }); app.route("/v1", analysisRoutes(() => clock));
});
afterEach(() => f.sqlite.close());
const range = () => ({ teamId: f.teamId, from: new Date(f.start).toISOString(), to: new Date(f.start + 200000).toISOString(), timezone: "Asia/Seoul" });
const call = (path: string, body?: unknown) => app.request(`https://synthetic/v1/${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, { DB: f.db });
const create = () => call("analysis-runs", { ...range(), idempotencyKey: crypto.randomUUID() });

test("owned dashboard, exact source/image/thread coverage preview and run creation share eligibility; preview is read-only", async () => {
  const teams = analysisDashboardSchema.parse(await (await call("analysis-dashboard")).json());
  expect(teams.teams).toHaveLength(1); expect(teams.teams[0]).toMatchObject({ members: 1, confirmed: 1, unmapped: 0 });
  const preview = analysisPreviewSchema.parse(await (await call("analysis-preview", range())).json());
  expect(preview.allowed).toBe(true); expect(preview.selection?.selectedCompetencies).toEqual(["clarity"]);
  expect(preview.coverage).toMatchObject({ status: "complete", sources: 1, imageReferences: 0, excluded: 1, threadRootsOutsidePeriod: 2 });
  expect(JSON.stringify(preview)).not.toContain(f.text);
  expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toHaveLength(0);
  expect(f.sqlite.query("SELECT * FROM queue_jobs").all()).toHaveLength(0);
  expect((await create()).status).toBe(202);
});

test("period/timezone boundaries, incomplete coverage, withdrawn consent, absent settings and no observations explain the same server rejection", async () => {
  const preview = async (body = range()) => analysisPreviewSchema.parse(await (await call("analysis-preview", body)).json());
  expect((await call("analysis-preview", { ...range(), from: range().to })).status).toBe(400);
  expect((await call("analysis-preview", { ...range(), timezone: "Invalid/Zone" })).status).toBe(400);
  expect((await call("analysis-preview", { ...range(), selectedCompetencies: ["decision_execution"] })).status).toBe(400);
  expect((await preview({ ...range(), to: new Date(clock + 1).toISOString() })).reasons).toContain("FUTURE_PERIOD");
  expect((await preview({ ...range(), from: new Date(f.start - 1).toISOString() })).reasons).toContain("PERIOD_OUTSIDE_COURSE");
  f.sqlite.run("UPDATE collection_coverage SET status = 'partial'");
  expect((await preview()).reasons).toContain("COVERAGE_INCOMPLETE"); expect((await create()).status).toBe(409);
  f.sqlite.run("UPDATE collection_coverage SET status = 'complete'");
  f.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = ?", [clock]);
  expect((await preview()).reasons).toContain("DATA_USE_BLOCKED"); expect((await create()).status).toBe(409);
  f.sqlite.run("DELETE FROM course_rubric_settings"); expect((await preview()).reasons).toContain("SETTINGS_REQUIRED");
  f.sqlite.run("DELETE FROM message_refs"); expect((await preview()).reasons).toContain("NO_DATA"); expect((await create()).status).toBe(409);
});

test("a stopped collection may analyze an explicitly allowed historical interval; changing consent after preview blocks creation", async () => {
  f.sqlite.run("UPDATE teams SET collection_status = 'paused'"); f.sqlite.run("UPDATE collection_windows SET ended_at = ?, end_reason = 'professor'", [clock]);
  expect(analysisPreviewSchema.parse(await (await call("analysis-preview", range())).json()).allowed).toBe(true);
  f.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = ?", [clock]);
  expect((await create()).status).toBe(409); expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toHaveLength(0);
});

test("a failed or unfinished collection is not labeled as an empty observed period", async () => {
  f.sqlite.run("DELETE FROM message_refs");
  for (const status of ["running", "partial", "failed"]) {
    f.sqlite.run("UPDATE collection_coverage SET status = ?", [status]);
    const preview = analysisPreviewSchema.parse(await (await call("analysis-preview", range())).json());
    expect(preview.reasons).toContain("COVERAGE_INCOMPLETE"); expect(preview.reasons).not.toContain("NO_DATA");
  }
  f.sqlite.run("UPDATE collection_coverage SET status = 'complete'");
  expect(analysisPreviewSchema.parse(await (await call("analysis-preview", range())).json()).reasons).toContain("NO_DATA");
});

test("coverage changing immediately before the creation batch rolls back run, spec and queue together", async () => {
  const db = { ...f.db, batch: async (statements: any) => {
    f.sqlite.run("UPDATE collection_coverage SET status = 'failed'"); return f.db.batch(statements);
  } };
  const result = await app.request("https://synthetic/v1/analysis-runs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...range(), idempotencyKey: crypto.randomUUID() }) }, { DB: db });
  expect(result.status).toBe(409);
  for (const table of ["analysis_runs", "analysis_specs", "queue_jobs"]) expect(f.sqlite.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
});

test("run history pages all versions without exposing another professor or model output; deleted and foreign resources share 404", async () => {
  for (let i = 0; i < 22; i++) expect((await create()).status).toBe(202);
  const path = `teams/${f.teamId}/analysis-runs`, first = analysisRunListSchema.parse(await (await call(path)).json());
  expect(first.runs).toHaveLength(20); expect(first.runs[0]!.version).toBe(22); expect(first.nextBefore).toBe(3);
  const second = analysisRunListSchema.parse(await (await call(`${path}?before=${first.nextBefore}`)).json());
  expect(second.runs.map(r => r.version)).toEqual([2, 1]); expect(second.nextBefore).toBeNull();
  expect((await call(`${path}?before=bad`)).status).toBe(400);
  professor = professors[1]!;
  expect(analysisDashboardSchema.parse(await (await call("analysis-dashboard")).json()).teams).toHaveLength(0);
  expect((await call(path)).status).toBe(404); expect((await call("analysis-preview", range())).status).toBe(404);
  expect((await call(`analysis-runs/${first.runs[0]!.id}`)).status).toBe(404);
});

test("dashboard and preview remain session-protected, no-store and same-origin", async () => {
  const server = createApp();
  const result = await server.request("https://synthetic/v1/analysis-dashboard", {}, { DB: f.db } as any);
  expect(result.status).toBe(401); expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect((await server.request("https://synthetic/v1/analysis-preview", { method: "POST", headers: { Origin: "https://other.invalid", "Content-Type": "application/json" }, body: JSON.stringify(range()) }, { DB: f.db } as any)).status).toBe(403);
});

test("actual run API plus UI client survives a lost create response and refresh with one run, restores status, then cancels", async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  let drop = true;
  const fetcher = (async (url, init) => {
    const result = await app.request(`https://synthetic${url}`, init, { DB: f.db });
    if (url === "/v1/analysis-runs" && drop) { drop = false; throw Error("synthetic lost response"); }
    return result;
  }) as typeof fetch;
  const controller = new DashboardController(() => {}, professor.id, storage, fetcher, { teamId: f.teamId, runId: "" }, () => clock);
  await controller.load(); controller.setRange(range()); await controller.preview();
  await Promise.all([controller.create(), controller.create()]);
  expect(controller.getSnapshot().saved!.runId).toBeNull(); expect(controller.getSnapshot().error).not.toBe(""); controller.dispose();
  const restored = new DashboardController(() => {}, professor.id, storage, fetcher, { teamId: "", runId: "" }, () => clock);
  await restored.load(); await restored.create(true);
  const run = restored.getSnapshot().run!; expect(run.status).toBe("queued");
  expect(f.sqlite.query("SELECT * FROM analysis_runs").all()).toHaveLength(1); expect(f.sqlite.query("SELECT * FROM queue_jobs").all()).toHaveLength(1);
  const again = new DashboardController(() => {}, professor.id, storage, fetcher, { teamId: f.teamId, runId: run.id }, () => clock);
  await again.load(); expect(again.getSnapshot().run?.id).toBe(run.id);
  await again.action("cancel"); expect(again.getSnapshot().run?.status).toBe("cancelled");
  expect(analysisRunResponseSchema.parse(await (await call(`analysis-runs/${run.id}`)).json()).status).toBe("cancelled");
  again.newVersion(); expect(again.getSnapshot().saved).toBeNull(); expect(again.getSnapshot().preview).toBeNull();
});
