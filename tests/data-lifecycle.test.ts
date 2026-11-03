import { afterEach, beforeEach, expect, test } from "bun:test";
import { collectionFixture } from "./helpers/collection";
import { collectionGate, dataEpochGuard, processingWriteGuard, purgeTeam, requestErasure, retentionDeadline, retentionDeadlineSql, runValidityGuard, sweepDataRetention } from "@teamplanet/collection";
import { JobStore } from "@teamplanet/queue";
import { Hono } from "hono";
import { lifecycleRoutes } from "../apps/api/src/lifecycle";
import type { ProtectedEnv } from "../apps/api/src/guard";
import * as fixtures from "@teamplanet/contracts/fixtures";

let f: Awaited<ReturnType<typeof collectionFixture>>;
const runId = "run_00000000-0000-4000-8000-000000000001";
beforeEach(async () => { f = await collectionFixture(); });
afterEach(() => f.sqlite.close());
const count = (table: string) => (f.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
function addRun(valid = true) {
  f.sqlite.run("INSERT INTO analysis_runs VALUES (?, ?, 'from', 'to', 'finalized', NULL, ?)", [runId, f.teamId, f.professor.id]);
  if (valid) f.sqlite.run("INSERT INTO run_data_validity (run_id, team_id, data_epoch) SELECT ?, team_id, epoch FROM team_data_versions WHERE team_id = ?", [runId, f.teamId]);
  f.sqlite.run("INSERT INTO evidence_events VALUES ('evidence_synthetic', ?, '[]', '[]', 'synthetic summary', '[]')", [runId]);
}
test("UTC calendar three months matches SQL at month-end, leap year and millisecond boundaries", () => {
  for (const [date, expected] of [["2026-11-30T12:34:56.123Z", "2027-02-28T12:34:56.123Z"], ["2023-11-30T00:00:00.000Z", "2024-02-29T00:00:00.000Z"], ["2026-01-31T23:59:59.999Z", "2026-04-30T23:59:59.999Z"]]) {
    const ends = Date.parse(date!); f.sqlite.run("UPDATE courses SET ends_at = ?", [ends]);
    expect(retentionDeadline(ends)).toBe(Date.parse(expected!));
    expect((f.sqlite.query(`SELECT ${retentionDeadlineSql("c")} AS deadline FROM courses c`).get() as any).deadline).toBe(Date.parse(expected!));
  }
});
test("withdrawal invalidates finalized output, cancels leased jobs and cannot be reversed by regrant", async () => {
  addRun(); await runValidityGuard(f.db, runId, f.now()).run();
  const store = new JobStore(f.db, f.now);
  const row = await store.register({ kind: "analysis.stage", runId, stage: "evidence_extraction", chunkId: "chunk1" });
  const lease = (await store.claim(row.job_key, 0))!;
  f.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = 4");
  await expect(runValidityGuard(f.db, runId, f.now()).run()).rejects.toThrow();
  await expect(store.commit(lease, "stale", "ref")).rejects.toThrow("JOB_LEASE_LOST");
  expect((await store.get(row.job_key))!.error_code).toBe("DATA_INVALIDATED");
  expect((f.sqlite.query("SELECT deleted_at, content_hash FROM message_refs").get() as any).content_hash).toBeNull();
  f.sqlite.run("UPDATE consents SET status = 'granted', recorded_at = 5");
  await expect(runValidityGuard(f.db, runId, f.now()).run()).rejects.toThrow();
  expect((f.sqlite.query("SELECT deleted_at FROM message_refs").get() as any).deleted_at).not.toBeNull();
  expect(count("consent_history")).toBe(3);
});
test("source edits invalidate both old epoch writes and runs; unverified legacy runs fail closed", async () => {
  addRun(false); await expect(runValidityGuard(f.db, runId, f.now()).run()).rejects.toThrow();
  f.sqlite.run("INSERT INTO run_data_validity SELECT ?, team_id, epoch, NULL, NULL FROM team_data_versions", [runId]);
  const epoch = (f.sqlite.query("SELECT epoch FROM team_data_versions").get() as any).epoch;
  f.sqlite.run("UPDATE message_refs SET revision = '9999999999.000000'");
  await expect(dataEpochGuard(f.db, f.teamId, epoch).run()).rejects.toThrow();
  await expect(runValidityGuard(f.db, runId, f.now()).run()).rejects.toThrow();
});
test("historical processing stays available after course end only until exact retention deadline; ingestion stays closed", async () => {
  const ends = f.start + 2 * 86400000;
  f.sqlite.run("UPDATE courses SET ends_at = ?", [ends]);
  const guard = (now: number) => processingWriteGuard(f.db, { teamId: f.teamId, from: f.start + 100000, now });
  await guard(ends + 1).run();
  expect((await collectionGate(f.db, { teamId: f.teamId, at: f.start + 100000, now: ends + 1, slackUserId: f.userId })).allowed).toBe(false);
  await guard(retentionDeadline(ends) - 1).run();
  await expect(guard(retentionDeadline(ends)).run()).rejects.toThrow();
});
test("early erasure blocks immediately, rolls back on failure, retries and purges related history atomically", async () => {
  addRun(); await requestErasure(f.db, f.teamId, "request", f.now());
  expect((await collectionGate(f.db, { teamId: f.teamId, at: f.start + 100000, now: f.now(), slackUserId: f.userId })).allowed).toBe(false);
  f.sqlite.run("CREATE TRIGGER synthetic_failure BEFORE DELETE ON evidence_events BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  await expect(purgeTeam(f.db, f.teamId, f.now())).rejects.toThrow("ERASURE_FAILED");
  expect(count("evidence_events")).toBe(1); expect(count("consent_history")).toBe(1);
  expect((f.sqlite.query("SELECT status FROM data_erasure_jobs").get() as any).status).toBe("failed");
  expect(await purgeTeam(f.db, f.teamId, f.now())).toBe(false);
  f.sqlite.run("DROP TRIGGER synthetic_failure");
  expect(await purgeTeam(f.db, f.teamId, f.now() + 120000)).toBe(true);
  for (const table of ["evidence_events", "analysis_runs", "message_refs", "image_refs", "consent_history", "consents", "consent_confirmations", "data_invalidations"]) expect(count(table)).toBe(0);
  expect(await purgeTeam(f.db, f.teamId, f.now() + 120000)).toBe(false);
  expect(f.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
test("interrupted claim expires; concurrent sweeps complete once and clear receipts at calendar expiry", async () => {
  await requestErasure(f.db, f.teamId, "request", f.now());
  f.sqlite.run("UPDATE data_erasure_jobs SET status = 'processing', attempts = 1, next_attempt_at = ?", [f.now() + 60000]);
  expect(await purgeTeam(f.db, f.teamId, f.now())).toBe(false);
  const results = await Promise.all([purgeTeam(f.db, f.teamId, f.now() + 60000), purgeTeam(f.db, f.teamId, f.now() + 60000)]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const ends = f.start + 60 * 86400000;
  await sweepDataRetention(f.db, retentionDeadline(ends));
  expect(count("data_erasure_jobs")).toBe(0);
  expect((f.sqlite.query("SELECT purged_at FROM team_data_versions").get() as any).purged_at).not.toBeNull();
});
test("interruption on the last attempt becomes an actionable failure instead of staying processing forever", async () => {
  await requestErasure(f.db, f.teamId, "request", f.now());
  f.sqlite.run("UPDATE data_erasure_jobs SET status = 'processing', attempts = 5, next_attempt_at = ?", [f.now()]);
  await sweepDataRetention(f.db, f.now());
  expect((f.sqlite.query("SELECT status, error_code FROM data_erasure_jobs").get() as any)).toEqual({ status: "failed", error_code: "ERASURE_FAILED" });
  expect(count("message_refs")).toBe(1);
});
test("owner-only operation status exposes failures and prevents another professor from erasing", async () => {
  let professor = fixtures.professors[1]!;
  const app = new Hono<ProtectedEnv>();
  app.use("*", async (c, next) => { c.set("professor", professor); await next(); });
  app.route("/", lifecycleRoutes(f.now));
  const call = (suffix: string, body?: unknown) => app.request(`http://synthetic/teams/${f.teamId}/${suffix}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, { DB: f.db });
  expect((await call("data-erasure", { reason: "request" })).status).toBe(404);
  expect(count("data_erasure_jobs")).toBe(0);
  professor = f.professor;
  expect((await call("data-erasure/retry", {})).status).toBe(409);
  expect((await call("data-erasure", { reason: "request" })).status).toBe(202);
  const status = await (await call("data-status")).json() as any;
  expect(status.blockedAt).not.toBeNull(); expect(status.erasure.status).toBe("pending");
  await purgeTeam(f.db, f.teamId, f.now());
  expect((await (await call("data-status")).json() as any).purgedAt).not.toBeNull();
});
test("erasing one team preserves a shared student's audit history until the other team is also purged", async () => {
  const other = "team_00000000-0000-4000-8000-000000000014";
  f.sqlite.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name) VALUES (?, ?, ?, 'CSHAREDAUDIT', 'synthetic other team')", [other, f.course.id, f.workspace.id]);
  f.sqlite.run("INSERT INTO team_members VALUES (?, ?, ?, ?)", [other, f.studentId, f.course.id, f.workspace.id]);
  f.sqlite.run("INSERT INTO audit_events (actor_professor_id, action, target_type, target_id, result, recorded_at) VALUES (?, 'consent.set', 'student', ?, 'succeeded', 0)", [f.professor.id, f.studentId]);
  await requestErasure(f.db, f.teamId, "request", f.now()); await purgeTeam(f.db, f.teamId, f.now());
  expect(count("audit_events")).toBe(1);
  await requestErasure(f.db, other, "request", f.now()); await purgeTeam(f.db, other, f.now());
  expect(count("audit_events")).toBe(0);
});
