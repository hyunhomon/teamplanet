import { expect, test } from "bun:test";
import { analysisPreviewSchema } from "@teamplanet/contracts";
import { professors, failures } from "@teamplanet/contracts/fixtures";
import { dashboardFixture, dashboardPreviewFixture, dashboardRunFixture, dashboardStatusFixtures, dashboardEmptyFixtures } from "@teamplanet/contracts/dashboard-fixtures";
import { DashboardController, seoulDateTime, seoulInput, statusLabels } from "../apps/web/src/lib/analysis-dashboard";
import { setupLocation } from "../apps/web/src/lib/setup";
const at = Date.parse(dashboardPreviewFixture.checkedAt), teamId = dashboardRunFixture.teamId;
const range = { from: dashboardPreviewFixture.from, to: dashboardPreviewFixture.to, timezone: "Asia/Seoul" };
function harness() {
  const memory = new Map<string, string>(), calls: { path: string; body: any }[] = [];
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  const state = { now: at, unauthorized: false, rate: false, bad: false, dashboard: structuredClone(dashboardFixture), preview: structuredClone(dashboardPreviewFixture),
    run: structuredClone(dashboardRunFixture), delay: null as Promise<void> | null, expired: 0 };
  const fetcher = (async (url, init) => {
    const path = String(url).replace("/v1/", ""), body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, body });
    if (state.delay) await state.delay;
    if (state.unauthorized) return Response.json(failures.signedOut.body, { status: 401 });
    if (state.rate) return Response.json(failures.rateLimited.body, { status: 429, headers: { "Retry-After": "9" } });
    if (path === "analysis-dashboard") return Response.json(state.dashboard);
    if (path === "analysis-preview") return Response.json(state.bad ? { ...state.preview, teamId: "team_00000000-0000-4000-8000-000000000099" } : state.preview);
    if (path.startsWith("teams/")) return Response.json({ teamId, runs: [state.run], nextBefore: null });
    if (path.endsWith("/cancel")) { state.run.status = "cancelled"; return Response.json(state.run); }
    if (path.endsWith("/resume")) { state.run.status = "queued"; return Response.json(state.run); }
    return Response.json(state.bad ? { ...state.run, teamId: "team_00000000-0000-4000-8000-000000000099" } : state.run);
  }) as typeof fetch;
  const make = (location = { teamId, runId: "" }) => new DashboardController(() => state.expired++, professors[0]!.id, storage, fetcher, location, () => state.now);
  return { state, calls, storage, memory, make, controller: make() };
}
test("server stage/status fixtures render distinct labels and polling replaces only the selected actual run", async () => {
  const h = harness(); await h.controller.load(); await h.controller.selectRun(h.state.run.id);
  for (const run of dashboardStatusFixtures) {
    h.state.run = structuredClone(run); await h.controller.poll();
    expect(h.controller.getSnapshot().run?.status).toBe(run.status); expect(statusLabels[run.status]).toBeTruthy();
  }
  expect(statusLabels.blocked_provider_billing).toContain("402"); expect(statusLabels.failed_model).not.toContain("402");
});
test("no teams, inactive collection, unset rubric, no observations and partial coverage are explicit, never auto-eligible", async () => {
  const h = harness(); h.state.dashboard = dashboardEmptyFixtures.noTeams;
  const c = h.make({ teamId: "", runId: "" }); await c.load(); expect(c.getSnapshot().teams).toHaveLength(0);
  h.state.dashboard = structuredClone(dashboardFixture); h.state.dashboard.teams[0]!.selection = null; h.state.dashboard.teams[0]!.team.collectionStatus = "inactive";
  await h.controller.load(); expect(h.controller.getSnapshot().teams[0]!.selection).toBeNull();
  for (const fixture of [dashboardEmptyFixtures.noData, dashboardEmptyFixtures.partial]) {
    h.state.preview = analysisPreviewSchema.parse(fixture); h.controller.setRange(range); await h.controller.preview();
    expect(h.controller.getSnapshot().preview?.allowed).toBe(false); await h.controller.create();
  }
  expect(h.calls.filter(c => c.path === "analysis-runs")).toHaveLength(0);
});
test("duplicate clicks, refresh and explicit new version preserve one idempotency key; storage contains only request metadata", async () => {
  const h = harness(); await h.controller.load(); h.controller.setRange(range); await h.controller.preview();
  await Promise.all([h.controller.create(), h.controller.create()]);
  expect(h.calls.filter(c => c.path === "analysis-runs")).toHaveLength(1);
  const body = h.calls.find(c => c.path === "analysis-runs")!.body;
  expect(Object.keys(body).sort()).toEqual(["from", "idempotencyKey", "teamId", "timezone", "to"]);
  expect([...h.memory.values()].join()).not.toContain("synthetic-test-key");
  const restored = h.make(); await restored.load(); expect(restored.getSnapshot().run?.id).toBe(h.state.run.id);
  await restored.create(true); expect(h.calls.filter(c => c.path === "analysis-runs")).toHaveLength(1);
  restored.newVersion(); expect(restored.getSnapshot().saved).not.toBeNull(); // An active run cannot be replaced from this action.
  h.state.run.status = "cancelled"; await restored.poll(); restored.newVersion();
  restored.setRange(range); await restored.preview(); await restored.create();
  expect(h.calls.filter(c => c.path === "analysis-runs")[1]!.body.idempotencyKey).not.toBe(body.idempotencyKey);
});

test("manual refresh reads the selected run again and cancellation updates its history row", async () => {
  const h = harness(); await h.controller.load(); await h.controller.selectRun(h.state.run.id);
  h.state.run.status = "review"; await h.controller.load(); expect(h.controller.getSnapshot().run?.status).toBe("review");
  await h.controller.action("cancel"); expect(h.controller.getSnapshot().runs[0]!.status).toBe("cancelled");
});
test("fresh preview is required after editing and after a minute; schema-valid foreign responses never enable creation", async () => {
  const h = harness(); await h.controller.load(); h.controller.setRange(range); await h.controller.preview();
  h.controller.invalidatePreview(); expect(h.controller.getSnapshot().preview).toBeNull(); await h.controller.create();
  await h.controller.preview(); h.state.now += 60001; await h.controller.create();
  expect(h.calls.filter(c => c.path === "analysis-runs")).toHaveLength(0);
  h.state.now = at; h.state.bad = true; await h.controller.preview(); expect(h.controller.getSnapshot().preview).toBeNull();
  await h.controller.selectRun(h.state.run.id); expect(h.controller.getSnapshot().run).toBeNull();
});
test("401 hides private state and reauthenticates; 429 respects Retry-After; disposed response cannot restore private data", async () => {
  const h = harness(); await h.controller.load(); await h.controller.selectRun(h.state.run.id);
  h.state.unauthorized = true; await h.controller.poll();
  expect(h.state.expired).toBe(1); expect(h.controller.getSnapshot().teams).toHaveLength(0); expect(h.controller.getSnapshot().run).toBeNull();
  h.state.unauthorized = false; h.state.rate = true; await h.controller.load();
  const count = h.calls.length; await h.controller.load(); expect(h.calls.length).toBe(count);
  h.state.now = h.controller.getSnapshot().retryAt; h.state.rate = false; await h.controller.load(); expect(h.controller.getSnapshot().teams).toHaveLength(1);
  let release!: () => void; h.state.delay = new Promise<void>(resolve => { release = resolve; });
  const pending = h.controller.load(), before = h.controller.getSnapshot(); h.controller.dispose(); release(); await pending;
  expect(h.controller.getSnapshot()).toBe(before);
});
test("blocking storage prevents an unrecoverable POST; invalid date, offset and URL parameters cannot change protected scope", async () => {
  const h = harness(); const c = new DashboardController(() => {}, professors[0]!.id,
    { getItem: () => null, setItem: () => { throw Error(); }, removeItem: () => {} }, (async (url, init) => {
      if (url === "/v1/analysis-dashboard") return Response.json(dashboardFixture);
      if (url === "/v1/analysis-preview") return Response.json(dashboardPreviewFixture);
      if (init?.method === "POST") throw Error("must not create");
      return Response.json({ teamId, runs: [], nextBefore: null });
    }) as typeof fetch, { teamId, runId: "" }, () => at);
  await c.load(); c.setRange(range); await c.preview(); await c.create(); expect(c.getSnapshot().error).toContain("저장소"); expect(c.getSnapshot().saved).toBeNull();
  expect(seoulDateTime("2026-11-01T09:00")).toBe("2026-11-01T00:00:00.000Z");
  expect(seoulInput("2026-10-31T15:00:00.000Z")).toBe("2026-11-01T00:00");
  for (const bad of ["2026-02-30T09:00", "2026-11-01T24:00", "2026-11-01T09:00Z", ""]) expect(seoulDateTime(bad)).toBeNull();
  const url = setupLocation(`?view=analysis&team=${teamId}&run=${h.state.run.id}&token=secret&next=https://other.invalid`);
  expect(url.runId).toBe(h.state.run.id); expect(url.search).not.toContain("token"); expect(url.search).not.toContain("next");
});
