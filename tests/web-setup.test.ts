import { expect, test } from "bun:test";
import { course, team, student, consent, workspace, failures } from "@teamplanet/contracts/fixtures";
import { activateTeamResponseSchema, inviteTeamResponseSchema, courseRubricResponseSchema, type RubricSelection } from "@teamplanet/contracts";
import { activationReasons, SetupController, setupLocation } from "../apps/web/src/lib/setup";

const at = Date.parse("2026-10-26T00:00:00.000Z");
function fixture() {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let activated = false;
  let denied = false;
  let confirmed = true;
  let mismatched = false;
  let signedOut = false;
  let delay: Promise<void> | null = null;
  const replies: Record<string, unknown> = {
    "slack/connection": { status: "connected", workspace: { ...workspace, name: "합성 워크스페이스", installedAt: "2026-10-26T00:00:00.000Z", createdAt: undefined }, missingScopes: [] },
    courses: course.list, teams: team.list,
    [`courses/${course.response.id}/students`]: student.list,
    [`courses/${course.response.id}/pilot`]: { courseId: course.response.id, consentVersion: consent.grant.version, endsAt: "2027-02-28T00:00:00.000Z", policyApproved: true },
    [`courses/${course.response.id}/rubric`]: { courseId: course.response.id, selection: null, updatedAt: null },
    [`teams/${team.response.id}/members`]: team.members,
    [`teams/${team.response.id}/membership`]: { teamId: team.response.id, checkedAt: "2026-10-26T00:00:00.000Z", botInChannel: true, members: [{ ...team.members.members[0], inChannel: true }], unmappedChannelMembers: [], complete: true },
  };
  // Keep exact shared response shapes; no actual workspace or student data.
  const connection = replies["slack/connection"] as { workspace: Record<string, unknown> };
  delete connection.workspace.createdAt;
  const membership = replies[`teams/${team.response.id}/membership`] as { members: Record<string, unknown>[] };
  membership.members = [{ studentId: student.response.id, slackUserId: team.member.slackUserId, inChannel: true }];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("/v1/", "");
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (delay) await delay;
    if (signedOut) return Response.json(failures.signedOut.body, { status: 401 });
    if (method === "PUT" && path.endsWith("/rubric")) {
      replies[path] = { courseId: course.response.id, selection: JSON.parse(String(init?.body)), updatedAt: new Date(at).toISOString() };
      return Response.json(replies[path]);
    }
    if (method === "POST" && path.endsWith("activate")) {
      if (denied) return Response.json(failures.missingConsent.body, { status: 409 });
      activated = true; return Response.json(team.activated);
    }
    if (method === "POST" && path.endsWith("invite")) return Response.json(team.manualInvite);
    if (path.endsWith("/collection")) return Response.json({ teamId: mismatched ? "team_00000000-0000-4000-8000-000000000002" : team.response.id, collectionStatus: activated ? "active" : "inactive", windows: [] });
    if (path.endsWith("/consents")) return Response.json({ consents: [{ ...consent.response, studentConfirmedAt: confirmed ? "2026-10-26T00:00:00.000Z" : null }] });
    if (!(path in replies)) throw new Error(`Unexpected request: ${path}`);
    return Response.json(replies[path]);
  }) as typeof fetch;
  let expired = 0;
  const controller = new SetupController(() => expired++, fetcher, { courseId: "", teamId: "" }, () => at);
  return { controller, calls, replies, expired: () => expired,
    deny: () => { denied = true; }, revoke: () => { confirmed = false; }, mismatch: () => { mismatched = true; },
    signOut: () => { signedOut = true; }, delay: (value: Promise<void>) => { delay = value; } };
}

test("restores selection from server lists and live membership, not client query flags", async () => {
  const h = fixture(); await h.controller.refresh();
  const s = h.controller.getSnapshot();
  expect(s.error).toBe(""); expect(s.courseId).toBe(course.response.id); expect(s.teamId).toBe(team.response.id);
  expect(s.collection?.collectionStatus).toBe("inactive"); expect(activationReasons(s, at)).toEqual([]);
  expect(h.calls.every(c => c.method === "GET")).toBe(true);
});
test("activation is not optimistic; actual server denial removes usable activation state", async () => {
  const h = fixture(); await h.controller.refresh(); h.deny();
  await h.controller.mutate(`teams/${team.response.id}/activate`, activateTeamResponseSchema, {});
  expect(h.controller.getSnapshot().collection).toBeNull();
  expect(h.controller.getSnapshot().error).toContain("동의");
  expect(activationReasons(h.controller.getSnapshot(), at).length).toBeGreaterThan(0);
});
test("successful activation is followed by a fresh server read", async () => {
  const h = fixture(); await h.controller.refresh();
  await h.controller.mutate(`teams/${team.response.id}/activate`, activateTeamResponseSchema, {});
  expect(h.controller.getSnapshot().collection?.collectionStatus).toBe("active");
  expect(h.calls.find(c => c.method === "POST")?.body).toEqual({});
  expect(h.calls.at(-1)?.method).toBe("GET");
});
test("student re-confirmation is required in addition to paper consent", async () => {
  const h = fixture(); h.revoke(); await h.controller.refresh();
  expect(activationReasons(h.controller.getSnapshot(), at).join(" ")).toContain("재확인");
});

test("rubric remains unset until explicit save and restores from a later server read", async () => {
  const h = fixture(); await h.controller.refresh();
  expect(h.controller.getSnapshot().rubric?.selection).toBeNull();
  const selection: RubricSelection = { rubricVersion: "communication-v1", selectedCompetencies: ["clarity", "decision_execution"] };
  await h.controller.mutate(`courses/${course.response.id}/rubric`, courseRubricResponseSchema, selection, "PUT");
  expect(h.controller.getSnapshot().rubric?.selection).toEqual(selection);
  await h.controller.refresh();
  expect(h.controller.getSnapshot().rubric?.selection).toEqual(selection);
  expect(h.calls.filter(c => c.method === "PUT")).toHaveLength(1);
});

test("another course's rubric response is rejected even when team responses are valid", async () => {
  const h = fixture(); h.replies[`courses/${course.response.id}/rubric`] = {
    courseId: "course_00000000-0000-4000-8000-000000000002", selection: null, updatedAt: null,
  };
  await h.controller.refresh();
  expect(h.controller.getSnapshot().rubric).toBeNull();
  expect(h.controller.getSnapshot().error).not.toBe("");
});
test("schema-valid response for another team cannot enable activation", async () => {
  const h = fixture(); h.mismatch(); await h.controller.refresh();
  expect(h.controller.getSnapshot().error).not.toBe(""); expect(h.controller.getSnapshot().collection).toBeNull();
});
test("manual invitation is preserved as an actionable result", async () => {
  const h = fixture(); await h.controller.refresh();
  await h.controller.mutate(`teams/${team.response.id}/invite`, inviteTeamResponseSchema, { studentId: student.response.id }, "POST", result => result.status);
  expect(h.controller.getSnapshot().notice).toBe("manual_invite_required");
});
test("duplicate writes are suppressed and disposed reads cannot revive setup state", async () => {
  const h = fixture(); await h.controller.refresh();
  let finish!: () => void;
  h.delay(new Promise<void>(resolve => { finish = resolve; }));
  const pending = h.controller.mutate(`teams/${team.response.id}/activate`, activateTeamResponseSchema, {});
  await h.controller.mutate(`teams/${team.response.id}/activate`, activateTeamResponseSchema, {});
  expect(h.calls.filter(c => c.method === "POST")).toHaveLength(1);
  h.controller.dispose(); finish(); await pending;
  expect(h.controller.getSnapshot().collection).toBeNull();
});
test("session loss removes account-specific state and triggers login", async () => {
  const h = fixture(); await h.controller.refresh(); h.signOut(); await h.controller.refresh();
  expect(h.expired()).toBe(1); expect(h.controller.getSnapshot().courses).toEqual([]); expect(h.controller.getSnapshot().students).toEqual([]);
});
test("OAuth outcomes and resource IDs survive login routing; arbitrary URLs and tokens do not", () => {
  const value = setupLocation(`?slack=cancelled&course=${course.response.id}&team=${team.response.id}&token=secret&next=https://evil.invalid`);
  expect(value.outcome).toBe("cancelled"); expect(value.courseId).toBe(course.response.id);
  expect(value.search).not.toContain("secret"); expect(value.search).not.toContain("evil");
  expect(setupLocation("?slack=<script>&course=bad&team=wrong").search).toBe("");
});

test("429 Retry-After prevents additional reads until the server deadline", async () => {
  let now = at;
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({ error: { ...failures.rateLimited.body.error, retryAfterSeconds: 60 } }, { status: 429, headers: { "Retry-After": "120" } });
  }) as unknown as typeof fetch;
  const controller = new SetupController(() => {}, fetcher, { courseId: "", teamId: "" }, () => now);
  await controller.refresh();
  expect(controller.getSnapshot().retryAt).toBe(at + 120_000);
  const count = calls; now += 60_000; await controller.refresh(); expect(calls).toBe(count);
  now += 60_000; await controller.refresh(); expect(calls).toBeGreaterThan(count);
});
