import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { consumeMessage, JobStore } from "@teamplanet/queue";
import { createApp, type Bindings } from "../apps/api/src/index";
import { createHandlers } from "../apps/consumer/src/index";
import { sqliteD1 } from "./helpers/d1";

// Synthetic Slack events end to end: signed intake → durable job → consumer → D1, on the real migrations.
const ORIGIN = "https://teamplanet.cloby.co";
const SECRET = "synthetic-signing-secret";
const [prof] = fixtures.professors;
const [course] = fixtures.courses;
const WS = fixtures.workspace;
const TEAM = "team_00000000-0000-4000-8000-0000000000b1";
const STUDENT = "student_00000000-0000-4000-8000-0000000000b1";
const CHANNEL = "CSYNTHCH01";
const USER = "USYNTHSTU1";
const BOT = "USYNTHBOT1";
const TEXT = "합성 메시지 원문 — 저장되면 안 됨";
const START = Date.parse("2026-10-28T00:00:00.000Z");
const tsAt = (ms: number, micro = 100) => `${Math.floor(ms / 1000)}.${String(micro).padStart(6, "0")}`;

let clock: number;
let database: ReturnType<typeof sqliteD1>;
let sent: QueueEnvelope[];
let env: Bindings;
let app: ReturnType<typeof createApp>;
let counter: number;

beforeEach(() => {
  clock = START + 60 * 60_000;
  counter = 0;
  database = sqliteD1();
  const sql = database.sqlite;
  sql.run("INSERT INTO professors VALUES (?, ?, 0)", [prof!.id, prof!.email]);
  sql.run("INSERT INTO consent_policies VALUES ('pilot-form-v1', 0, 'operator-synthetic')");
  sql.run("INSERT INTO courses (id, professor_id, name, created_at, consent_version, ends_at) VALUES (?, ?, ?, 0, 'pilot-form-v1', ?)", [course!.id, prof!.id, course!.name, START + 60 * 86_400_000]);
  sql.run("INSERT INTO workspaces VALUES (?, ?, 0)", [WS.id, WS.slackTeamId]);
  sql.run(`INSERT INTO slack_installations (workspace_id, team_name, app_id, bot_user_id, scopes, token_ciphertext, installed_by_slack_user_id,
    installed_by_professor_id, installed_at) VALUES (?, 'x', 'ASYNTH0001', ?, '', 'v1.sealed.synthetic', 'USYNTHPROF', ?, 0)`, [WS.id, BOT, prof!.id]);
  sql.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name, collection_status) VALUES (?, ?, ?, ?, '1조', 'active')", [TEAM, course!.id, WS.id, CHANNEL]);
  sql.run("INSERT INTO students VALUES (?, ?, '합성 학생', 0)", [STUDENT, course!.id]);
  sql.run("INSERT INTO slack_users VALUES (?, ?)", [WS.id, USER]);
  sql.run("INSERT INTO student_slack_mappings VALUES (?, ?, ?, ?)", [STUDENT, course!.id, WS.id, USER]);
  sql.run("INSERT INTO team_members VALUES (?, ?, ?, ?)", [TEAM, STUDENT, course!.id, WS.id]);
  sql.run("INSERT INTO consents VALUES (?, ?, 'granted', 'pilot-form-v1', 1)", [TEAM, STUDENT]);
  sql.run("INSERT INTO consent_confirmations (token_hash, team_id, student_id, version, issued_by_professor_id, created_at, expires_at, confirmed_at) VALUES ('hash', ?, ?, 'pilot-form-v1', ?, 2, 99999999999999, 3)", [TEAM, STUDENT, prof!.id]);
  sql.run("UPDATE consent_confirmations SET consent_history_id=(SELECT MAX(id) FROM consent_history)");
  sql.run("INSERT INTO collection_windows (team_id, started_at) VALUES (?, ?)", [TEAM, START]);
  sent = [];
  const queue = { send: async (body: QueueEnvelope) => { sent.push(body); } } as unknown as Queue<QueueEnvelope>;
  env = { DB: database.db, WORK_QUEUE: queue, SLACK_SIGNING_SECRET: SECRET } as Bindings;
  app = createApp({ now: () => clock, sleep: async () => {}, policy: { otpTtlMs: 1, resendCooldownMs: 1, maxRequestsPerHour: 1, maxVerifyAttempts: 1, sessionTtlMs: 1, minRequestMs: 0, challengeRetentionMs: 1 }, mailer: () => async () => {} });
});
afterEach(() => database.sqlite.close());

async function sign(body: string, timestamp: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return `v0=${Array.from(mac, b => b.toString(16).padStart(2, "0")).join("")}`;
}
async function post(payload: unknown, options: { timestamp?: number; signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? Math.floor(clock / 1000);
  return app.request(`${ORIGIN}/v1/slack/events`, {
    method: "POST", body,
    headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": String(timestamp), "X-Slack-Signature": options.signature ?? await sign(body, timestamp) },
  }, env);
}
const callback = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: "event_callback", team_id: WS.slackTeamId, api_app_id: "ASYNTH0001", event_id: `EvSYNTH${String(++counter).padStart(4, "0")}`, event, ...extra });
const message = (ts: string, extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "channel", channel: CHANNEL, user: USER, text: TEXT, ts, ...extra });
async function drain() {
  const store = new JobStore(database.db, () => clock);
  const handlers = createHandlers(database.db, () => clock);
  const dlq = { send: async () => {} } as unknown as Queue<QueueEnvelope>;
  for (const body of sent.splice(0)) {
    let acked = false;
    await consumeMessage({ id: crypto.randomUUID(), body, attempts: 1, ack: () => { acked = true; }, retry: () => {} }, store, dlq, handlers);
    expect(acked).toBe(true);
  }
}
const refs = () => database.sqlite.query("SELECT slack_ts, user_id, revision, content_hash IS NOT NULL AS hashed, deleted_at IS NOT NULL AS deleted FROM message_refs ORDER BY slack_ts").all();
const outcomes = () => database.sqlite.query("SELECT kind, outcome, channel_id FROM slack_event_refs ORDER BY rowid").all();
const teamStatus = () => (database.sqlite.query("SELECT collection_status FROM teams WHERE id = ?").get(TEAM) as { collection_status: string }).collection_status;
const dump = () => JSON.stringify(database.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  .map(t => database.sqlite.query(`SELECT * FROM "${(t as { name: string }).name}"`).all()));

test("only correctly signed, fresh requests are accepted; url_verification answers the challenge", async () => {
  const challenge = { type: "url_verification", challenge: "synthetic-challenge" };
  expect(await (await post(challenge)).json()).toEqual({ challenge: "synthetic-challenge" });
  const body = callback(message(tsAt(START + 1000)));
  expect((await post(body, { signature: `v0=${"0".repeat(64)}` })).status).toBe(401);
  expect((await post(body, { timestamp: Math.floor(clock / 1000) - 301 })).status).toBe(401); // replay window is 5 minutes
  expect((await post(challenge, { signature: "" })).status).toBe(401);
  delete env.SLACK_SIGNING_SECRET;
  expect((await post(body)).status).toBe(503);
  expect([outcomes(), sent]).toEqual([[], []]);
});

test("out-of-scope events are acknowledged without collecting any metadata", async () => {
  const before = START - 60_000;
  for (const event of [
    message(tsAt(START + 1000), { channel_type: "im", channel: "DSYNTHDM01" }),
    message(tsAt(START + 1000), { channel: "CSYNTHOTHER" }),
    message(tsAt(START + 1000), { bot_id: "BSYNTH0001" }),
    message(tsAt(before)), // before activation: never backfilled
    message(tsAt(START + 1000), { subtype: "channel_topic" }),
    { type: "reaction_added", user: USER },
  ]) expect((await post(callback(event))).status).toBe(200);
  expect((await post(callback(message(tsAt(START + 1000)), { team_id: "TSYNTHOTHER" }))).status).toBe(200);
  expect(outcomes()).toEqual([
    { kind: "ignored", outcome: "ignored:not_public_channel", channel_id: null },
    { kind: "ignored", outcome: "ignored:channel", channel_id: null },
    { kind: "ignored", outcome: "ignored:bot", channel_id: null },
    { kind: "ignored", outcome: "ignored:outside_window", channel_id: null },
    { kind: "ignored", outcome: "ignored:subtype", channel_id: null },
    { kind: "ignored", outcome: "ignored:event_type", channel_id: null },
    { kind: "ignored", outcome: "ignored:workspace", channel_id: null },
  ]);
  expect(sent).toEqual([]);
  expect(dump()).not.toContain("DSYNTHDM01");
});

test("a message is stored once as a reference with a fingerprint; text never reaches the queue or D1", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const event = callback(message(tsAt(START + 1000), { thread_ts: tsAt(START + 500) }));
  expect((await post(event)).status).toBe(200);
  expect((await post(event)).status).toBe(200); // Slack retry with the same event_id
  expect(sent).toHaveLength(1);
  expect(JSON.stringify(sent)).not.toContain(TEXT);
  await drain();
  expect(refs()).toEqual([{ slack_ts: tsAt(START + 1000), user_id: USER, revision: tsAt(START + 1000), hashed: 1, deleted: 0 }]);
  expect(outcomes()).toEqual([{ kind: "message", outcome: "stored", channel_id: CHANNEL }]);
  expect(dump()).not.toContain(TEXT);
  expect(JSON.stringify(errors.mock.calls)).not.toContain(TEXT);
  errors.mockRestore();
});

test("duplicates, reordering and delete races end in one reference with the final state", async () => {
  const ts = tsAt(START + 2000);
  const edit = callback({ type: "message", subtype: "message_changed", channel_type: "channel", channel: CHANNEL, event_ts: tsAt(START + 3000),
    message: { type: "message", user: USER, text: "수정된 합성 메시지", ts, edited: { user: USER, ts: tsAt(START + 3000) } } });
  await post(edit);              // the edit arrives first
  await post(callback(message(ts))); // then the original create
  await post(callback(message(ts))); // and a second delivery under another event id
  await drain();
  expect(refs()).toEqual([{ slack_ts: ts, user_id: USER, revision: tsAt(START + 3000), hashed: 1, deleted: 0 }]);

  const gone = tsAt(START + 4000);
  await post(callback(message(gone)));
  await post(callback({ type: "message", subtype: "message_deleted", channel_type: "channel", channel: CHANNEL, deleted_ts: gone, ts: tsAt(START + 5000) }));
  await drain();
  await post(callback(message(gone))); // a late re-delivery of the create after the delete
  await drain();
  expect(refs()).toEqual([
    { slack_ts: ts, user_id: USER, revision: tsAt(START + 3000), hashed: 1, deleted: 0 },
    { slack_ts: gone, user_id: USER, revision: gone, hashed: 0, deleted: 1 },
  ]);
});

test("an event accepted before a withdrawal is not stored after it", async () => {
  await post(callback(message(tsAt(START + 1000))));
  // Withdrawal pauses the team between intake and the consumer.
  database.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = ?", [clock]);
  database.sqlite.run("UPDATE teams SET collection_status = 'paused'");
  database.sqlite.run("UPDATE collection_windows SET ended_at = ?, end_reason = 'consent_changed'", [clock]);
  await drain();
  expect(refs()).toEqual([]);
  expect(outcomes()).toEqual([{ kind: "message", outcome: "ignored:team_inactive", channel_id: CHANNEL }]);
});

test("unknown members, leavers, bot removal and uninstall stop collection", async () => {
  const reopen = () => {
    database.sqlite.run("UPDATE teams SET collection_status = 'active'");
    database.sqlite.run("INSERT INTO collection_windows (team_id, started_at) VALUES (?, ?)", [TEAM, clock]);
  };
  const lastReason = () => (database.sqlite.query("SELECT end_reason FROM collection_windows ORDER BY id DESC LIMIT 1").get() as { end_reason: string }).end_reason;

  await post(callback({ type: "member_joined_channel", channel: CHANNEL, user: USER }));
  await drain();
  expect(teamStatus()).toBe("active"); // a consented member re-joining is fine

  for (const [event, reason] of [
    [{ type: "member_joined_channel", channel: CHANNEL, user: "USYNTHNEW1" }, "unknown_participant"],
    [{ type: "member_left_channel", channel: CHANNEL, user: USER }, "member_left"],
    [{ type: "member_left_channel", channel: CHANNEL, user: BOT }, "bot_removed"],
    [message(tsAt(clock + 1000), { user: "USYNTHNEW2" }), "unknown_participant"],
  ] as const) {
    clock += 1000;
    await post(callback(event));
    await drain();
    expect([teamStatus(), lastReason()]).toEqual(["paused", reason]);
    reopen();
  }
  expect(refs()).toEqual([]); // the stranger's message itself is not stored

  await post(callback({ type: "app_uninstalled" }));
  await drain();
  expect([teamStatus(), lastReason()]).toEqual(["paused", "slack_revoked"]);
  expect(database.sqlite.query("SELECT token_ciphertext FROM slack_installations").get()).toEqual({ token_ciphertext: null });
});

test("an unknown author's message stops the channel without keeping its fingerprint or message metadata", async () => {
  const stranger = "USYNTHNEW3";
  const ts = tsAt(START + 2000);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TEXT))), b => b.toString(16).padStart(2, "0")).join("");
  await post(callback(message(ts, { user: stranger, thread_ts: tsAt(START + 1000) })));
  expect(database.sqlite.query("SELECT kind, channel_id, user_id, slack_ts, thread_ts, revision, content_hash FROM slack_event_refs").all()).toEqual([
    { kind: "message", channel_id: CHANNEL, user_id: stranger, slack_ts: null, thread_ts: null, revision: null, content_hash: null },
  ]);
  await drain();
  expect(teamStatus()).toBe("paused");
  expect(database.sqlite.query("SELECT end_reason FROM collection_windows WHERE ended_at IS NOT NULL").all()).toEqual([{ end_reason: "unknown_participant" }]);
  expect(outcomes()).toEqual([{ kind: "message", outcome: "paused:unknown_participant", channel_id: CHANNEL }]);
  expect(refs()).toEqual([]);
  expect(dump()).not.toContain(hash);
  expect(dump()).not.toContain(ts);
});


test("withdrawal between the gate read and intake or consumer commit rolls all source writes back", async () => {
 const withdraw=()=>{
  database.sqlite.run("UPDATE consents SET status='withdrawn' WHERE team_id=?",[TEAM]);
  database.sqlite.run("UPDATE teams SET collection_status='paused' WHERE id=?",[TEAM]);
  database.sqlite.run("UPDATE collection_windows SET ended_at=?, end_reason='consent_changed' WHERE team_id=? AND ended_at IS NULL",[clock,TEAM]);
 };
 const batch=database.db.batch.bind(database.db);
 let target="INSERT INTO slack_event_refs";
 let raced=false;
 database.db.batch=async statements=>{
  if(!raced && statements.some(s=>(s as unknown as {sql:string}).sql.includes(target))){raced=true;withdraw();}
  return batch(statements);
 };
 expect((await post(callback(message(tsAt(START+1000))))).status).toBe(500);
 expect(database.sqlite.query("SELECT count(*) AS n FROM slack_event_refs").get()).toEqual({n:0});
 expect(sent).toHaveLength(0);
 // A new grant and confirmation allow a fresh event, but not a withdrawal racing its final commit.
 database.sqlite.run("UPDATE consents SET status='granted' WHERE team_id=?",[TEAM]);
 database.sqlite.run("UPDATE consent_confirmations SET consent_history_id=(SELECT MAX(id) FROM consent_history)");
 database.sqlite.run("UPDATE teams SET collection_status='active' WHERE id=?",[TEAM]);
 database.sqlite.run("UPDATE collection_windows SET ended_at=NULL, end_reason=NULL WHERE team_id=?",[TEAM]);
 raced=true;
 expect((await post(callback(message(tsAt(START+2000))))).status).toBe(200);
 target="INSERT INTO message_refs";raced=false;
 const body=sent.shift()!;
 let acked=false;let retried=false;
 const delivery={id:crypto.randomUUID(),body,attempts:1,ack:()=>{acked=true;},retry:()=>{retried=true;}};
 const store=new JobStore(database.db,()=>clock);
 const dlq={send:async()=>{}} as unknown as Queue<QueueEnvelope>;
 await consumeMessage(delivery,store,dlq,createHandlers(database.db,()=>clock));
 expect(acked).toBe(false);expect(retried).toBe(true);
 expect(raced).toBe(true);
 expect(database.sqlite.query("SELECT count(*) AS n FROM message_refs").get()).toEqual({n:0});
 expect(database.sqlite.query("SELECT count(*) AS n FROM job_checkpoints WHERE name='apply'").get()).toEqual({n:0});
});

test("a withdrawal between the consumer's gate check and its write stores nothing", async () => {
  await post(callback(message(tsAt(START + 1000))));
  const batch = database.db.batch.bind(database.db);
  let race = true;
  database.db.batch = (async statements => {
    if (race && statements.some(s => (s as unknown as { sql: string }).sql.includes("INSERT INTO message_refs"))) {
      race = false;
      database.sqlite.run("UPDATE consents SET status = 'withdrawn'");
      database.sqlite.run("UPDATE teams SET collection_status = 'paused'");
    }
    return batch(statements);
  }) as typeof database.db.batch;
  const [body] = sent.splice(0);
  let retried = false;
  await consumeMessage({ id: crypto.randomUUID(), body: body!, attempts: 1, ack: () => {}, retry: () => { retried = true; } },
    new JobStore(database.db, () => clock), { send: async () => {} } as unknown as Queue<QueueEnvelope>, createHandlers(database.db, () => clock));
  expect(retried).toBe(true);
  expect(refs()).toEqual([]);

  clock += 60_000;
  sent.push(body!);
  await drain();
  expect(refs()).toEqual([]);
  expect(outcomes()).toEqual([{ kind: "message", outcome: "ignored:team_inactive", channel_id: CHANNEL }]);
});
