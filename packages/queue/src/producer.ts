import type { Queue } from "@cloudflare/workers-types";
import { queueEnvelopeSchema, type QueueEnvelope, type QueueJob } from "@teamplanet/contracts";
import { JobStore, MAX_DISPATCHES, type JobRow } from "./store";

export async function dispatchJob(store: JobStore, queue: Queue<QueueEnvelope>, row: JobRow) {
  const now = store.now();
  const claimed = await store.db.prepare(`UPDATE queue_jobs SET dispatches = dispatches + 1, dispatch_at = ?, updated_at = ?
    WHERE job_key = ? AND generation = ? AND dispatches < ? AND dispatch_at <= ?
    AND (status IN ('pending', 'retry') OR (status = 'running' AND lease_until <= ?)) RETURNING *`)
    .bind(now + 60_000, now, row.job_key, row.generation, MAX_DISPATCHES, now, now).first<JobRow>();
  if (!claimed) return false;
  // If send fails, the durable outbox remains due for the scheduled dispatcher.
  await queue.send(queueEnvelopeSchema.parse({ version: 1, generation: claimed.generation, job: JSON.parse(claimed.job_json) }));
  return true;
}
export async function enqueueJob(store: JobStore, queue: Queue<QueueEnvelope>, input: QueueJob) {
  const row = await store.register(input);
  await dispatchJob(store, queue, row);
  return row.job_key;
}
export async function forwardDead(store: JobStore, dlq: Queue<QueueEnvelope>, row: JobRow) {
  if (row.dead_lettered_at !== null) return;
  const reserved = await store.db.prepare(`UPDATE queue_jobs SET dlq_attempts = dlq_attempts + 1
    WHERE job_key = ? AND generation = ? AND status = 'dead' AND dead_lettered_at IS NULL AND dlq_attempts < 5 RETURNING job_key`)
    .bind(row.job_key, row.generation).first();
  // After bounded forwarding failures, keep the durable dead row for operator recovery.
  if (!reserved) return;
  await dlq.send(queueEnvelopeSchema.parse({ version: 1, generation: row.generation, job: JSON.parse(row.job_json) }));
  await store.db.prepare(`UPDATE queue_jobs SET dead_lettered_at = ? WHERE job_key = ? AND generation = ? AND status = 'dead'`)
    .bind(store.now(), row.job_key, row.generation).run();
}
export async function flushOutbox(store: JobStore, queue: Queue<QueueEnvelope>, dlq: Queue<QueueEnvelope>) {
  const now = store.now();
  // Transport attempts are bounded independently from actual handler executions.
  await store.db.prepare(`UPDATE queue_jobs SET status = 'dead', error_code = 'DELIVERY_EXHAUSTED', updated_at = ?
    WHERE dispatches >= ? AND dispatch_at <= ? AND
    (status IN ('pending', 'retry') OR (status = 'running' AND lease_until <= ?))`)
    .bind(now, MAX_DISPATCHES, now, now).run();
  const rows = await store.db.prepare(`SELECT * FROM queue_jobs WHERE
    (status = 'dead' AND dead_lettered_at IS NULL AND dlq_attempts < 5) OR
    (dispatch_at <= ? AND (status IN ('pending', 'retry') OR (status = 'running' AND lease_until <= ?)))
    ORDER BY updated_at LIMIT 50`).bind(now, now).all<JobRow>();
  const results = await Promise.allSettled(rows.results.map(async row => {
    await store.expireExhausted(row.job_key);
    const current = (await store.get(row.job_key))!;
    if (current.status === "dead") await forwardDead(store, dlq, current);
    else await dispatchJob(store, queue, current);
  }));
  if (results.some(result => result.status === "rejected")) throw new Error("QUEUE_DISPATCH_INCOMPLETE");
}
