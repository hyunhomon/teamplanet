import type { D1PreparedStatement, Message, Queue } from "@cloudflare/workers-types";
import { jobKey, queueEnvelopeSchema, type QueueEnvelope, type QueueJob } from "@teamplanet/contracts";
import { JobStore, LeaseLost } from "./store";
import { forwardDead } from "./producer";

export type JobErrorCode = "HANDLER_UNREGISTERED" | "REFERENCE_NOT_FOUND" | "DATA_INVALID" | "UPSTREAM_UNAVAILABLE" |
  "RATE_LIMITED" | "PROVIDER_BILLING_BLOCKED" | "HANDLER_FAILURE";
export class JobError extends Error {
  constructor(readonly code: JobErrorCode, readonly retryable: boolean, readonly retryAfterSeconds?: number) { super(code); }
}
export type JobContext = {
  heartbeat(): Promise<void>;
  checkpoint(name: string): Promise<{ reference: string } | null>;
  commit(name: string, reference: string, writes?: D1PreparedStatement[]): Promise<boolean>;
};
export type JobHandler = (job: QueueJob, context: JobContext) => Promise<void>;
export type JobHandlers = Partial<Record<QueueJob["kind"], JobHandler>>;
export const retryDelay = (attempt: number, hint?: number) => Math.max(
  Math.min(3600, 2 ** Math.min(attempt, 12)),
  hint !== undefined && Number.isFinite(hint) && hint >= 0 ? Math.ceil(hint) : 0,
);
const deliveryDelay = (seconds: number) => Math.min(86_400, seconds);

export async function consumeMessage(
  message: Pick<Message<unknown>, "id" | "body" | "attempts" | "ack" | "retry">,
  store: JobStore, dlq: Queue<QueueEnvelope>, handlers: JobHandlers,
) {
  try {
    const parsed = queueEnvelopeSchema.safeParse(message.body);
    if (!parsed.success) {
      await store.rejection(message.id, "INVALID_ENVELOPE");
      // Explicit retry; platform max_retries sends the original message to the native DLQ.
      message.retry({ delaySeconds: deliveryDelay(retryDelay(message.attempts)) });
      return;
    }
    const envelope = parsed.data;
    const key = jobKey(envelope.job);
    let row = await store.register(envelope.job);
    if (envelope.generation < row.generation) { message.ack(); return; }
    if (envelope.generation !== row.generation) {
      await store.rejection(message.id, "INVALID_GENERATION");
      message.retry({ delaySeconds: deliveryDelay(retryDelay(message.attempts)) }); return;
    }
    if (row.status === "completed") { message.ack(); return; }
    await store.expireExhausted(key);
    row = (await store.get(key))!;
    if (row.status === "dead") { await forwardDead(store, dlq, row); message.ack(); return; }
    const lease = await store.claim(key, row.generation);
    if (!lease) {
      message.retry({ delaySeconds: deliveryDelay(Math.max(1, Math.ceil((Math.max(row.available_at, row.lease_until ?? 0) - store.now()) / 1000))) });
      return;
    }
    try {
      const handler = handlers[envelope.job.kind];
      if (!handler) throw new JobError("HANDLER_UNREGISTERED", false);
      await handler(envelope.job, {
        heartbeat: () => store.heartbeat(lease), checkpoint: name => store.checkpoint(key, name),
        commit: (name, reference, writes = []) => {
          if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(reference)) throw new JobError("DATA_INVALID", false);
          return store.commit(lease, name, reference, writes);
        },
      });
      await store.complete(lease);
      message.ack();
    } catch (error) {
      if (error instanceof LeaseLost) { message.retry({ delaySeconds: 1 }); return; }
      const failure = error instanceof JobError ? error : new JobError("HANDLER_FAILURE", true);
      const delay = retryDelay(lease.attempt, failure.retryAfterSeconds);
      const retry = await store.fail(lease, failure.code, failure.retryable, delay);
      if (retry) message.retry({ delaySeconds: deliveryDelay(delay) });
      else { await forwardDead(store, dlq, (await store.get(key))!); message.ack(); }
    }
  } catch {
    // DB/transport errors are never an implicit success ACK; native delivery retries are bounded.
    message.retry({ delaySeconds: deliveryDelay(retryDelay(message.attempts)) });
  }
}
