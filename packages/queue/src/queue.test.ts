import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Queue } from "@cloudflare/workers-types";
import { jobKey, queueEnvelopeSchema, type QueueEnvelope, type QueueJob } from "@teamplanet/contracts";
import { sqliteD1 } from "../../../tests/helpers/d1";
import { consumeMessage, JobError, retryDelay, type JobHandlers } from "./runner";
import { dispatchJob, enqueueJob, flushOutbox } from "./producer";
import { JobStore, LEASE_MS, LeaseLost, MAX_ATTEMPTS, MAX_DISPATCHES } from "./store";

const probe: QueueJob = { kind: "system.probe", probeId: "00000000-0000-4000-8000-000000000010" };
const envelope: QueueEnvelope = { version: 1, generation: 0, job: probe };
const key = jobKey(probe);
let clock: number;
let database: ReturnType<typeof sqliteD1>;
let store: JobStore;
let dlq: ReturnType<typeof fakeQueue>;
function fakeQueue(fail = false) {
  const sent: QueueEnvelope[] = [];
  const queue = { send: async (body: QueueEnvelope) => { sent.push(body); if (fail) throw new Error("synthetic transport outage"); } } as unknown as Queue<QueueEnvelope>;
  return { queue, sent };
}
function message(body: unknown = envelope, attempts = 1) {
  return {
    id: crypto.randomUUID(), body, attempts, acked: false, retrySeconds: undefined as number | undefined,
    ack() { this.acked = true; }, retry(options?: { delaySeconds?: number }) { this.retrySeconds = options?.delaySeconds; },
  };
}
const increment = () => database.db.prepare("UPDATE synthetic_effects SET value = value + 1 WHERE id = 'output'");
const effects = () => (database.sqlite.query("SELECT value FROM synthetic_effects").get() as { value: number }).value;
const successful: JobHandlers = {
  "system.probe": async (_job, context) => { await context.commit("output", "synthetic-output", [increment()]); },
};
beforeEach(() => {
  clock = 1000;
  database = sqliteD1();
  store = new JobStore(database.db, () => clock);
  dlq = fakeQueue();
  database.sqlite.exec("CREATE TABLE synthetic_effects (id text PRIMARY KEY, value integer NOT NULL); INSERT INTO synthetic_effects VALUES ('output', 0)");
});
afterEach(() => database.sqlite.close());

test("contracts allow references only and distinguish event/run:stage:chunk keys", () => {
  queueEnvelopeSchema.parse(envelope);
  const event = {
    kind: "slack.event" as const, workspaceId: "workspace_00000000-0000-4000-8000-000000000001",
    eventId: "EvSYNTH001", eventRef: "event_00000000-0000-4000-8000-000000000001",
  };
  expect(jobKey(event)).toBe(`event:${event.workspaceId}:${event.eventId}`);
  const analysis = { kind: "analysis.stage" as const, runId: "run_00000000-0000-4000-8000-000000000001", stage: "review" as const, chunkId: "chunk-1" };
  queueEnvelopeSchema.parse({ ...envelope, job: analysis });
  expect(jobKey(analysis)).not.toBe(jobKey({ ...analysis, chunkId: "chunk-2" }));
  for (const body of [null, {}, { ...envelope, version: 2 }, { ...envelope, generation: 4 },
    { ...envelope, job: { ...event, text: "synthetic private conversation", token: "synthetic-secret" } },
    { ...envelope, job: { ...analysis, runId: "invalid" } }, { ...envelope, job: { kind: "future.unknown" } }]) {
    expect(queueEnvelopeSchema.safeParse(body).success).toBe(false);
  }
});

test("producer persists before sending and collapses duplicate submissions", async () => {
  const queue = fakeQueue();
  await Promise.all([enqueueJob(store, queue.queue, probe), enqueueJob(store, queue.queue, probe)]);
  expect(queue.sent).toEqual([envelope]);
  expect((await store.get(key))?.dispatches).toBe(1);
});

test("an event ID cannot be reused with a different stored event reference", async () => {
  const event: QueueJob = {
    kind: "slack.event", workspaceId: "workspace_00000000-0000-4000-8000-000000000001",
    eventId: "EvSYNTH001", eventRef: "event_00000000-0000-4000-8000-000000000001",
  };
  await store.register(event);
  await expect(store.register({ ...event, eventRef: "event_00000000-0000-4000-8000-000000000002" })).rejects.toThrow("JOB_ENVELOPE_CONFLICT");
  expect(JSON.parse((await store.get(jobKey(event)))!.job_json)).toEqual(event);
});

test("parallel deliveries execute once; completed redelivery after lost ACK does no work", async () => {
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let executions = 0;
  const handlers: JobHandlers = { "system.probe": async (_job, context) => {
    executions++; entered(); await wait; await context.commit("output", "synthetic-output", [increment()]);
  } };
  const first = message();
  const running = consumeMessage(first, store, dlq.queue, handlers);
  await started;
  const parallel = message();
  await consumeMessage(parallel, store, dlq.queue, handlers);
  expect(parallel.acked).toBe(false);
  expect(parallel.retrySeconds).toBe(60);
  release(); await running;
  const repeated = message();
  await consumeMessage(repeated, store, dlq.queue, handlers);
  expect(first.acked && repeated.acked).toBe(true);
  expect(executions).toBe(1); expect(effects()).toBe(1);
  expect((await store.get(key))?.attempts).toBe(1);
});

test("restart after output checkpoint before completion resumes without duplicate storage", async () => {
  await store.register(probe);
  const lease = (await store.claim(key, 0))!;
  await store.commit(lease, "output", "synthetic-output", [increment()]);
  clock += LEASE_MS + 1; // Hard interruption: no fail()/complete()/ACK ran.
  const restarted = new JobStore(database.db, () => clock);
  const retry = message();
  await consumeMessage(retry, restarted, dlq.queue, successful);
  expect(retry.acked).toBe(true); expect(effects()).toBe(1);
  expect((await store.get(key))?.status).toBe("completed");
  expect((await store.get(key))?.attempts).toBe(2);
});

test("expired/replaced lease cannot commit writes, complete, heartbeat or overwrite failure state", async () => {
  await store.register(probe);
  const old = (await store.claim(key, 0))!;
  clock += LEASE_MS + 1;
  const active = (await store.claim(key, 0))!;
  await expect(store.commit(old, "stale", "output", [increment()])).rejects.toBeInstanceOf(LeaseLost);
  await expect(store.complete(old)).rejects.toBeInstanceOf(LeaseLost);
  await expect(store.heartbeat(old)).rejects.toBeInstanceOf(LeaseLost);
  await expect(store.fail(old, "STALE", true, 1)).rejects.toBeInstanceOf(LeaseLost);
  expect(effects()).toBe(0);
  await store.commit(active, "output", "synthetic-output", [increment()]);
  await store.complete(active);
  expect(effects()).toBe(1);
});

test("checkpoint and application writes roll back together; parallel checkpoint commits store once", async () => {
  await store.register(probe);
  const lease = (await store.claim(key, 0))!;
  await expect(store.commit(lease, "rollback", "output", [increment(), database.db.prepare("INSERT INTO synthetic_effects VALUES ('output', 9)")])).rejects.toThrow();
  expect(await store.checkpoint(key, "rollback")).toBeNull(); expect(effects()).toBe(0);
  await Promise.all([store.commit(lease, "output", "output", [increment()]), store.commit(lease, "output", "output", [increment()])]);
  expect(effects()).toBe(1);
});

test("heartbeat extends an active lease; expired lease alone cannot write", async () => {
  await store.register(probe);
  const lease = (await store.claim(key, 0))!;
  clock += LEASE_MS - 1;
  await store.heartbeat(lease);
  clock += 2;
  expect(await store.claim(key, 0)).toBeNull();
  clock += LEASE_MS;
  await expect(store.commit(lease, "expired", "output", [increment()])).rejects.toBeInstanceOf(LeaseLost);
  expect(effects()).toBe(0);
});

test("transient failures back off and stop at the fifth actual execution", async () => {
  let executions = 0;
  const handlers: JobHandlers = { "system.probe": async () => { executions++; throw new JobError("UPSTREAM_UNAVAILABLE", true); } };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const delivery = message(envelope, attempt);
    await consumeMessage(delivery, store, dlq.queue, handlers);
    expect(delivery.acked).toBe(attempt === MAX_ATTEMPTS);
    if (attempt < MAX_ATTEMPTS) expect(delivery.retrySeconds).toBe(2 ** attempt);
    clock += 2 ** attempt * 1000;
  }
  await consumeMessage(message(), store, dlq.queue, handlers);
  expect(executions).toBe(5); expect(dlq.sent).toHaveLength(1);
  expect((await store.get(key))?.status).toBe("dead");
  expect(database.sqlite.query("SELECT * FROM job_failures").all()).toHaveLength(5);
  expect(retryDelay(99)).toBe(3600);
  expect(retryDelay(99, 99_999)).toBe(99_999);
  expect(retryDelay(1, NaN)).toBe(2);
});

test("provider Retry-After remains authoritative beyond the Queue single-delay limit", async () => {
  let executions = 0;
  const handlers: JobHandlers = { "system.probe": async () => {
    executions++; throw new JobError("RATE_LIMITED", true, 90_000);
  } };
  const first = message();
  await consumeMessage(first, store, dlq.queue, handlers);
  expect(first.retrySeconds).toBe(86_400);
  clock += 86_400_000;
  const early = message();
  await consumeMessage(early, store, dlq.queue, handlers);
  expect(early.retrySeconds).toBe(3600); expect(executions).toBe(1);
  const queue = fakeQueue();
  await flushOutbox(store, queue.queue, dlq.queue);
  expect(queue.sent).toHaveLength(0);
  clock += 3_600_000;
  await consumeMessage(message(), store, dlq.queue, successful);
  expect((await store.get(key))?.status).toBe("completed");
});

test("five hard interruptions cannot obtain a sixth lease", async () => {
  await store.register(probe);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    expect(await store.claim(key, 0)).not.toBeNull(); clock += LEASE_MS + 1;
  }
  await consumeMessage(message(), store, dlq.queue, successful);
  expect((await store.get(key))?.error_code).toBe("ATTEMPTS_EXHAUSTED");
  expect(effects()).toBe(0); expect(dlq.sent).toHaveLength(1);
});

test("provider billing/permanent failures go to DLQ without retry or fallback", async () => {
  const delivery = message();
  await consumeMessage(delivery, store, dlq.queue, { "system.probe": async () => { throw new JobError("PROVIDER_BILLING_BLOCKED", false); } });
  expect(delivery.acked).toBe(true); expect(delivery.retrySeconds).toBeUndefined();
  expect((await store.get(key))?.status).toBe("dead"); expect(dlq.sent).toEqual([envelope]);
});

test("invalid/unknown envelopes retry to native DLQ and are never success-ACKed or copied into failure records", async () => {
  const invalid = message({ version: 999, token: "synthetic-private-token", text: "synthetic-private-conversation" });
  await consumeMessage(invalid, store, dlq.queue, successful);
  expect(invalid.acked).toBe(false); expect(invalid.retrySeconds).toBe(2);
  const records = JSON.stringify(database.sqlite.query("SELECT * FROM queue_rejections").all());
  expect(records).toContain("INVALID_ENVELOPE"); expect(records).not.toContain("synthetic-private");
  expect(database.sqlite.query("SELECT * FROM queue_jobs").all()).toHaveLength(0);
});

test("a valid but unregistered kind is quarantined, not recorded as completed", async () => {
  const job: QueueJob = { kind: "analysis.stage", runId: "run_00000000-0000-4000-8000-000000000001", stage: "review", chunkId: "chunk-1" };
  await consumeMessage(message({ ...envelope, job }), store, dlq.queue, successful);
  expect((await store.get(jobKey(job)))?.error_code).toBe("HANDLER_UNREGISTERED");
  expect((await store.get(jobKey(job)))?.status).toBe("dead");
  expect(dlq.sent).toHaveLength(1);
});

test("outbox repairs interruption between DB registration and send, and send outages", async () => {
  const broken = fakeQueue(true);
  await expect(enqueueJob(store, broken.queue, probe)).rejects.toThrow();
  expect((await store.get(key))?.status).toBe("pending");
  clock += LEASE_MS + 1;
  const repaired = fakeQueue();
  await flushOutbox(store, repaired.queue, dlq.queue);
  expect(repaired.sent).toEqual([envelope]);
  await consumeMessage(message(repaired.sent[0]), store, dlq.queue, successful);
  clock += LEASE_MS + 1;
  await flushOutbox(store, repaired.queue, dlq.queue);
  expect(repaired.sent).toHaveLength(1); expect(effects()).toBe(1);
});

test("transport and DLQ forwarding outages have bounded sends and retain durable failures", async () => {
  await store.register(probe);
  const queue = fakeQueue();
  for (let i = 0; i < MAX_DISPATCHES; i++) {
    await dispatchJob(store, queue.queue, (await store.get(key))!); clock += LEASE_MS + 1;
  }
  const brokenDlq = fakeQueue(true);
  for (let i = 0; i < 6; i++) {
    try { await flushOutbox(store, queue.queue, brokenDlq.queue); } catch { /* forwarding failed, ledger is retained */ }
  }
  expect(queue.sent).toHaveLength(MAX_DISPATCHES); expect(brokenDlq.sent).toHaveLength(5);
  expect((await store.get(key))?.status).toBe("dead");
  expect((await store.get(key))?.error_code).toBe("DELIVERY_EXHAUSTED");
  expect((await store.get(key))?.dead_lettered_at).toBeNull();
});

test("recovery requires dead state and matching generation, preserves checkpoints, rejects stale replay", async () => {
  await store.register(probe);
  const lease = (await store.claim(key, 0))!;
  await expect(store.recover(key, 0, "issue-10")).rejects.toThrow("JOB_RECOVERY_REJECTED");
  await store.commit(lease, "output", "output", [increment()]);
  await store.fail(lease, "DATA_INVALID", false, 0);
  await store.recover(key, 0, "issue-10");
  await expect(store.recover(key, 0, "duplicate")).rejects.toThrow("JOB_RECOVERY_REJECTED");
  const stale = message();
  await consumeMessage(stale, store, dlq.queue, successful);
  expect(stale.acked).toBe(true); expect((await store.get(key))?.attempts).toBe(0);
  await consumeMessage(message({ ...envelope, generation: 1 }), store, dlq.queue, successful);
  expect(effects()).toBe(1); expect((await store.get(key))?.status).toBe("completed");
  await expect(store.recover(key, 1, "cannot-replay-completed")).rejects.toThrow();
  expect(database.sqlite.query("SELECT * FROM job_recoveries").all()).toHaveLength(1);
});

test("operator recovery cycles are bounded and future generations never execute", async () => {
  await store.register(probe);
  const future = message({ ...envelope, generation: 1 });
  await consumeMessage(future, store, dlq.queue, successful);
  expect(future.acked).toBe(false); expect((await store.get(key))?.attempts).toBe(0);
  for (let generation = 0; generation <= 3; generation++) {
    const lease = (await store.claim(key, generation))!;
    await store.fail(lease, "DATA_INVALID", false, 0);
    if (generation < 3) await store.recover(key, generation, "issue-10");
  }
  await expect(store.recover(key, 3, "too-many")).rejects.toThrow();
  expect(database.sqlite.query("SELECT * FROM job_recoveries").all()).toHaveLength(3);
});
