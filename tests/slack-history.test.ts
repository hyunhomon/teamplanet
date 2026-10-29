import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { sealToken } from "@teamplanet/collection";
import { consumeMessage, JobStore } from "@teamplanet/queue";
import { createHandlers } from "../apps/consumer/src/index";
import { sqliteD1 } from "./helpers/d1";

// A fake Slack channel with real cursor pagination; every person, ID and message is synthetic.
const [prof] = fixtures.professors;
const [course] = fixtures.courses;
const WS = fixtures.workspace;
const TEAM = "team_00000000-0000-4000-8000-0000000000c1";
const STUDENT = "student_00000000-0000-4000-8000-0000000000c1";
const CHANNEL = "CSYNTHCH01";
const USER = "USYNTHSTU1";
const STRANGER = "USYNTHNOPE";
const TEXT = "합성 기록 원문";
const START = Date.parse("2026-10-28T00:00:00.000Z");
const HOUR = 60 * 60_000;
const ts = (ms: number, micro = 0) => `${Math.floor(ms / 1000)}.${String(micro).padStart(6, "0")}`;

type Msg = { ts: string; user?: string; text?: string; thread_ts?: string; reply_count?: number; edited?: { ts: string }; bot_id?: string; subtype?: string };
let clock: number;
let database: ReturnType<typeof sqliteD1>;
let key: string;
let channel: Msg[];
let replies: Record<string, Msg[]>;
let pageSize: number;
let calls: { method: string; params: Record<string, string> }[];
let intercept: (method: string, params: Record<string, string>) => Response | undefined;
let retried: number[];

const cursorOf = (offset: number) => btoa(`offset:${offset}`); // base64 with "=" padding, like Slack's
const offsetOf = (cursor?: string) => (cursor ? Number(atob(cursor).split(":")[1]) : 0);
function page(list: Msg[], params: Record<string, string>) {
  const offset = offsetOf(params.cursor);
  const next = offset + pageSize < list.length ? cursorOf(offset + pageSize) : "";
  return new Response(JSON.stringify({ ok: true, messages: list.slice(offset, offset + pageSize), has_more: Boolean(next), response_metadata: { next_cursor: next } }));
}
const inRange = (m: Msg, params: Record<string, string>) => m.ts >= params.oldest! && m.ts <= params.latest!; // inclusive, like Slack
async function fakeSlack(url: string, init: RequestInit) {
  const method = url.replace("https://slack.com/api/", "");
  const params = Object.fromEntries(new URLSearchParams(String(init.body)));
  calls.push({ method, params });
  const forced = intercept(method, params);
  if (forced) return forced;
  if (method === "conversations.history") return page(channel.filter(m => inRange(m, params)).sort((a, b) => b.ts.localeCompare(a.ts)), params);
  if (method === "conversations.replies") {
    const root = channel.find(m => m.ts === params.ts) ?? { ts: params.ts!, user: USER, text: TEXT };
    return page([root, ...(replies[params.ts!] ?? []).filter(m => inRange(m, params))], params);
  }
  throw new Error(`unexpected Slack call ${method}`);
}

beforeEach(async () => {
  clock = START + 10 * HOUR;
  database = sqliteD1();
  const sql = database.sqlite;
  key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  sql.run("INSERT INTO professors VALUES (?, ?, 0)", [prof!.id, prof!.email]);
  sql.run("INSERT INTO consent_policies VALUES ('pilot-form-v1', 0, 'operator-synthetic')");
  sql.run("INSERT INTO courses (id, professor_id, name, created_at, consent_version, ends_at) VALUES (?, ?, ?, 0, 'pilot-form-v1', ?)", [course!.id, prof!.id, course!.name, START + 1000 * HOUR]);
  sql.run("INSERT INTO workspaces VALUES (?, ?, 0)", [WS.id, WS.slackTeamId]);
  sql.run(`INSERT INTO slack_installations (workspace_id, team_name, app_id, bot_user_id, scopes, token_ciphertext, installed_by_slack_user_id,
    installed_by_professor_id, installed_at) VALUES (?, 'x', 'ASYNTH0001', 'USYNTHBOT1', '', ?, 'USYNTHPROF', ?, 0)`, [WS.id, await sealToken(key, WS.id, "xoxb-synthetic"), prof!.id]);
  sql.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name, collection_status) VALUES (?, ?, ?, ?, '1조', 'active')", [TEAM, course!.id, WS.id, CHANNEL]);
  sql.run("INSERT INTO students VALUES (?, ?, '합성 학생', 0)", [STUDENT, course!.id]);
  sql.run("INSERT INTO slack_users VALUES (?, ?)", [WS.id, USER]);
  sql.run("INSERT INTO student_slack_mappings VALUES (?, ?, ?, ?)", [STUDENT, course!.id, WS.id, USER]);
  sql.run("INSERT INTO team_members VALUES (?, ?, ?, ?)", [TEAM, STUDENT, course!.id, WS.id]);
  sql.run("INSERT INTO consents VALUES (?, ?, 'granted', 'pilot-form-v1', 1)", [TEAM, STUDENT]);
  sql.run("INSERT INTO consent_confirmations VALUES ('hash', ?, ?, 'pilot-form-v1', ?, 2, 99999999999999, 3)", [TEAM, STUDENT, prof!.id]);
  sql.run("INSERT INTO collection_windows (team_id, started_at) VALUES (?, ?)", [TEAM, START]);
  channel = [];
  replies = {};
  pageSize = 2;
  calls = [];
  retried = [];
  intercept = () => undefined;
});
afterEach(() => database.sqlite.close());

const REQUEST = "00000000-0000-4000-8000-0000000000c1";
async function run(fromMs = START, toMs = START + 5 * HOUR, requestId = REQUEST) {
  const body: QueueEnvelope = { version: 1, generation: 0, job: { kind: "slack.history", requestId, teamId: TEAM, fromMs, toMs } };
  const dlq = { send: async () => {} } as unknown as Queue<QueueEnvelope>;
  let acked = false;
  await consumeMessage({ id: crypto.randomUUID(), body, attempts: 1, ack: () => { acked = true; }, retry: options => { retried.push(options?.delaySeconds ?? 0); } },
    new JobStore(database.db, () => clock), dlq, createHandlers(database.db, () => clock, { send: fakeSlack, tokenKey: key }));
  return acked;
}
const refs = () => database.sqlite.query("SELECT slack_ts, thread_ts, revision, deleted_at IS NOT NULL AS deleted, source FROM message_refs ORDER BY slack_ts").all() as { slack_ts: string; thread_ts: string | null; deleted: number }[];
const coverage = (requestId = REQUEST) => {
  const row = database.sqlite.query("SELECT status, reason, merged, excluded, tombstoned, old_thread_roots, limitations_json FROM collection_coverage WHERE request_id = ?").get(requestId) as Record<string, unknown>;
  return row && { ...row, limitations: JSON.parse(String(row.limitations_json)), limitations_json: undefined };
};
const msg = (ms: number, extra: Partial<Msg> = {}): Msg => ({ ts: ts(ms), user: USER, text: TEXT, ...extra });

test("many pages, an empty page and a long thread are restored once each, in order", async () => {
  const root = msg(START + HOUR, { reply_count: 5, thread_ts: ts(START + HOUR) });
  channel = [msg(START + 10), root, msg(START + 2 * HOUR), msg(START + 3 * HOUR), msg(START + 4 * HOUR, { subtype: "thread_broadcast", thread_ts: ts(START + HOUR) })];
  replies[root.ts] = [1, 2, 3, 4, 5].map(n => msg(START + HOUR + n * 1000, { thread_ts: root.ts }));
  // Slack may answer with an empty page that still has more.
  intercept = (method, params) => method === "conversations.history" && !params.cursor && calls.filter(c => c.method === method).length === 1
    ? new Response(JSON.stringify({ ok: true, messages: [], has_more: true, response_metadata: { next_cursor: cursorOf(0) } })) : undefined;
  expect(await run()).toBe(true);
  const stored = refs();
  expect(stored).toHaveLength(10);
  expect(new Set(stored.map(r => r.slack_ts)).size).toBe(10);
  expect(stored.filter(r => r.slack_ts !== root.ts && r.thread_ts === root.ts)).toHaveLength(6); // 5 replies + broadcast
  expect(coverage()).toMatchObject({ status: "complete", reason: null, merged: 10, excluded: 0, limitations: ["older_thread_replies_from_events_only"] });
  expect(JSON.stringify(database.sqlite.query("SELECT * FROM message_refs").all())).not.toContain(TEXT);
  expect(calls.filter(c => c.method === "conversations.replies").length).toBe(3); // 6 messages over pages of 2
});

test("window and request boundaries: same-ts edges, nothing before activation, outside time is partial", async () => {
  database.sqlite.run("UPDATE collection_windows SET ended_at = ?, end_reason = 'professor'", [START + 2 * HOUR]);
  database.sqlite.run("UPDATE teams SET collection_status = 'active'");
  database.sqlite.run("INSERT INTO collection_windows (team_id, started_at) VALUES (?, ?)", [TEAM, START + 3 * HOUR]);
  channel = [msg(START - 1000), msg(START), msg(START + 2 * HOUR - 1000), msg(START + 2 * HOUR), msg(START + 2.5 * HOUR), msg(START + 3 * HOUR), msg(START + 4 * HOUR)];
  expect(await run(START - HOUR, START + 4 * HOUR)).toBe(true);
  // Kept: [START, START+2h) and [START+3h, START+4h); the window edge at its start is inside, its end is outside.
  expect(refs().map(r => r.slack_ts)).toEqual([ts(START), ts(START + 2 * HOUR - 1000), ts(START + 3 * HOUR)]);
  expect(calls.every(c => c.params.oldest! >= ts(START))).toBe(true); // never asks Slack for pre-activation history
  expect(coverage()).toMatchObject({ status: "partial", limitations: ["outside_allowed_window", "older_thread_replies_from_events_only"] });
});

test("unconsented and bot authors are left out and reported, never stored", async () => {
  channel = [msg(START + 1000), msg(START + 2000, { user: STRANGER }), msg(START + 3000, { bot_id: "BSYNTH0001" }), msg(START + 4000, { subtype: "channel_join" })];
  await run();
  expect(refs().map(r => r.slack_ts)).toEqual([ts(START + 1000)]);
  expect(coverage()).toMatchObject({ status: "complete", excluded: 1, limitations: ["unconsented_author_excluded", "older_thread_replies_from_events_only"] });
});

test("a rate limit mid-run is retried with Retry-After and resumes from the saved cursor without duplicates", async () => {
  channel = [1, 2, 3, 4, 5].map(n => msg(START + n * 1000));
  let historyCalls = 0;
  intercept = method => (method === "conversations.history" && ++historyCalls === 2
    ? new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "Retry-After": "7" } }) : undefined);
  expect(await run()).toBe(false);
  expect(retried[0]).toBeGreaterThanOrEqual(7);
  expect(coverage()).toMatchObject({ status: "running", merged: 2 });
  clock += 60_000;
  calls = [];
  expect(await run()).toBe(true);
  expect(calls[0]!.params.cursor).toBe(cursorOf(2)); // the first page is not fetched again
  expect(refs()).toHaveLength(5);
  expect(coverage()).toMatchObject({ status: "complete", merged: 5 });
});

test("history merges with Events: newer edits win, tombstones stay, missing messages become tombstones", async () => {
  const insert = (slackTs: string, extra: { thread?: string; deleted?: boolean; firstSeen?: number; revision?: string } = {}) => database.sqlite.run(
    `INSERT INTO message_refs (team_id, channel_id, slack_ts, user_id, thread_ts, revision, content_hash, deleted_at, source, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'event', ?, ?)`,
    [TEAM, CHANNEL, slackTs, USER, extra.thread ?? null, extra.revision ?? slackTs, extra.deleted ? null : "hash", extra.deleted ? 1 : null, extra.firstSeen ?? START, START]);
  const edited = ts(START + 1000);
  insert(edited);                                  // Events saw the original
  insert(ts(START + 2000), { deleted: true });     // Events saw it deleted
  insert(ts(START + 3000));                        // deleted in Slack while no event arrived
  insert(ts(START + 5000), { thread: ts(START + 4000) }); // reply deleted in Slack
  insert(ts(START + 6000), { firstSeen: clock + 1 }); // arrived through Events after the run started: not judged
  channel = [msg(START + 1000, { edited: { ts: ts(START + 9000) } }), msg(START + 2000), msg(START + 4000, { reply_count: 1, thread_ts: ts(START + 4000) })];
  replies[ts(START + 4000)] = [];
  await run();
  const byTs = Object.fromEntries(refs().map(r => [r.slack_ts, r]));
  expect(byTs[edited]).toMatchObject({ revision: ts(START + 9000), deleted: 0 });
  expect(byTs[ts(START + 2000)]).toMatchObject({ deleted: 1 });
  expect(byTs[ts(START + 3000)]).toMatchObject({ deleted: 1 });
  expect(byTs[ts(START + 5000)]).toMatchObject({ deleted: 1 });
  expect(byTs[ts(START + 6000)]).toMatchObject({ deleted: 0 });
  expect(coverage()).toMatchObject({ status: "complete", tombstoned: 2 });
});

test("replies to threads that began before the window are read without pulling in the old root", async () => {
  const oldRoot = ts(START - HOUR);
  database.sqlite.run(`INSERT INTO message_refs (team_id, channel_id, slack_ts, user_id, thread_ts, revision, content_hash, source, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'hash', 'event', ?, ?)`, [TEAM, CHANNEL, ts(START + 1000), USER, oldRoot, ts(START + 1000), START, START]);
  channel = [msg(START - HOUR, { reply_count: 2, thread_ts: oldRoot })];
  replies[oldRoot] = [msg(START - 1000, { thread_ts: oldRoot }), msg(START + 1000, { thread_ts: oldRoot }), msg(START + 2000, { thread_ts: oldRoot })];
  await run();
  expect(refs().map(r => r.slack_ts)).toEqual([ts(START + 1000), ts(START + 2000)]);
  expect(coverage()).toMatchObject({ status: "complete", old_thread_roots: 1, limitations: ["thread_root_outside_window", "older_thread_replies_from_events_only"] });
});

test("permission problems, a paused team or a missing key fail the coverage instead of looking empty", async () => {
  channel = [msg(START + 1000)];
  intercept = method => (method === "conversations.history" ? new Response(JSON.stringify({ ok: false, error: "missing_scope" })) : undefined);
  expect(await run()).toBe(true);
  expect(coverage()).toMatchObject({ status: "failed", reason: "missing_scope" });

  intercept = () => undefined;
  database.sqlite.run("UPDATE teams SET collection_status = 'paused'");
  await run(START, START + HOUR, "00000000-0000-4000-8000-0000000000c2");
  expect(coverage("00000000-0000-4000-8000-0000000000c2")).toMatchObject({ status: "failed", reason: "team_inactive" });

  database.sqlite.run("UPDATE teams SET collection_status = 'active'");
  key = btoa(String.fromCharCode(...new Uint8Array(32))); // wrong key cannot open the token
  expect(await run(START, START + HOUR, "00000000-0000-4000-8000-0000000000c3")).toBe(false); // unreadable token is retried, not reported as empty
  expect(refs()).toEqual([]);
});
