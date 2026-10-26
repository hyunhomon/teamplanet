import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { jobKey, jobRecoverySchema, queueJobSchema, type QueueJob } from "@teamplanet/contracts";

export const MAX_ATTEMPTS = 5;
export const MAX_DISPATCHES = 20;
export const MAX_RECOVERIES = 3;
export const LEASE_MS = 60_000;
export type JobRow = {
  job_key: string; job_json: string; generation: number; status: "pending" | "running" | "retry" | "completed" | "dead";
  attempts: number; dispatches: number; available_at: number; dispatch_at: number;
  lease_token: string | null; lease_until: number | null; error_code: string | null; dead_lettered_at: number | null;
  dlq_attempts: number;
};
export type Lease = { key: string; token: string; generation: number; attempt: number };
export class LeaseLost extends Error { constructor() { super("JOB_LEASE_LOST"); } }

export class JobStore {
  constructor(readonly db: D1Database, readonly now: () => number = Date.now) {}
  async get(key: string) { return this.db.prepare("SELECT * FROM queue_jobs WHERE job_key = ?").bind(key).first<JobRow>(); }
  async register(input: QueueJob) {
    const job = queueJobSchema.parse(input);
    const key = jobKey(job);
    const json = JSON.stringify(job);
    await this.db.prepare(`INSERT INTO queue_jobs (job_key, job_json, created_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(job_key) DO NOTHING`).bind(key, json, this.now(), this.now()).run();
    const row = (await this.get(key))!;
    if (row.job_json !== json) throw new Error("JOB_ENVELOPE_CONFLICT");
    return row;
  }
  async claim(key: string, generation: number): Promise<Lease | null> {
    const token = crypto.randomUUID();
    const now = this.now();
    const row = await this.db.prepare(`UPDATE queue_jobs SET status = 'running', attempts = attempts + 1,
      lease_token = ?, lease_until = ?, dispatch_at = ?, updated_at = ?
      WHERE job_key = ? AND generation = ? AND attempts < ? AND
      ((status IN ('pending', 'retry') AND available_at <= ?) OR (status = 'running' AND lease_until <= ?))
      RETURNING attempts`).bind(token, now + LEASE_MS, now + LEASE_MS, now, key, generation, MAX_ATTEMPTS, now, now).first<{ attempts: number }>();
    return row ? { key, token, generation, attempt: row.attempts } : null;
  }
  async heartbeat(lease: Lease) {
    const now = this.now();
    const row = await this.db.prepare(`UPDATE queue_jobs SET lease_until = ?, dispatch_at = ?, updated_at = ?
      WHERE job_key = ? AND generation = ? AND lease_token = ? AND status = 'running' AND lease_until > ? RETURNING job_key`)
      .bind(now + LEASE_MS, now + LEASE_MS, now, lease.key, lease.generation, lease.token, now).first();
    if (!row) throw new LeaseLost();
  }
  async checkpoint(key: string, name: string) {
    return this.db.prepare("SELECT reference FROM job_checkpoints WHERE job_key = ? AND name = ?")
      .bind(key, name).first<{ reference: string }>();
  }
  // Trigger checks the active lease BEFORE any application mutation in the same D1 transaction.
  // The checkpoint PK also rolls back the entire batch if two callers commit the same step.
  async commit(lease: Lease, name: string, reference: string, writes: D1PreparedStatement[] = []) {
    if (await this.checkpoint(lease.key, name)) return false;
    const guard = this.db.prepare(`INSERT INTO job_checkpoints
      (job_key, name, reference, generation, lease_token, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(lease.key, name, reference, lease.generation, lease.token, this.now());
    try { await this.db.batch([guard, ...writes]); }
    catch (error) {
      if (await this.checkpoint(lease.key, name)) return false;
      const row = await this.get(lease.key);
      if (!row || row.lease_token !== lease.token || row.generation !== lease.generation || row.status !== "running" || row.lease_until! <= this.now()) throw new LeaseLost();
      throw error;
    }
    return true;
  }
  async complete(lease: Lease) {
    await this.commit(lease, "_completed", "completed", [this.db.prepare(`UPDATE queue_jobs
      SET status = 'completed', lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE job_key = ? AND generation = ? AND lease_token = ?`)
      .bind(this.now(), lease.key, lease.generation, lease.token)]);
  }
  async fail(lease: Lease, code: string, retryable: boolean, delay: number) {
    const now = this.now();
    const retry = retryable && lease.attempt < MAX_ATTEMPTS;
    const active = `job_key = ? AND generation = ? AND lease_token = ? AND status = 'running' AND lease_until > ?`;
    const results = await this.db.batch([
      this.db.prepare(`INSERT INTO job_failures (job_key, generation, attempt, code, retryable, recorded_at)
        SELECT job_key, generation, attempts, ?, ?, ? FROM queue_jobs WHERE ${active}`)
        .bind(code, Number(retryable), now, lease.key, lease.generation, lease.token, now),
      this.db.prepare(`UPDATE queue_jobs SET status = ?, error_code = ?, available_at = ?, dispatch_at = ?,
        lease_token = NULL, lease_until = NULL, updated_at = ? WHERE ${active}`)
        .bind(retry ? "retry" : "dead", code, now + delay * 1000, now + delay * 1000, now, lease.key, lease.generation, lease.token, now),
    ]);
    if (results[1]!.meta.changes !== 1) throw new LeaseLost();
    return retry;
  }
  async expireExhausted(key: string) {
    const now = this.now();
    await this.db.prepare(`UPDATE queue_jobs SET status = 'dead', error_code = 'ATTEMPTS_EXHAUSTED',
      lease_token = NULL, lease_until = NULL, updated_at = ? WHERE job_key = ? AND attempts >= ?
      AND (status IN ('pending', 'retry') OR (status = 'running' AND lease_until <= ?))`)
      .bind(now, key, MAX_ATTEMPTS, now).run();
  }
  async rejection(messageId: string, code: string) {
    await this.db.prepare(`INSERT INTO queue_rejections (message_id, code, recorded_at) VALUES (?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET code = excluded.code`)
      .bind(messageId, code, this.now()).run();
  }
  async recover(key: string, expectedGeneration: number, reasonRef: string) {
    jobRecoverySchema.parse({ key, generation: expectedGeneration, reasonRef });
    // INSERT triggers atomically check dead/generation/bounds, record reason, and reset the outbox.
    // This same single SQL operation is safe through the D1 operator API.
    await this.db.prepare(`INSERT INTO job_recoveries (job_key, generation, reason_ref, recorded_at)
      VALUES (?, ?, ?, ?)`).bind(key, expectedGeneration + 1, reasonRef, this.now()).run();
  }
}
