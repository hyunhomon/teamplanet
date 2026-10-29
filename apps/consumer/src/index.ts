import type { D1Database, ExportedHandler, Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import { planEvent, type EventRefRow } from "@teamplanet/collection";
import { consumeMessage, flushOutbox, JobError, JobStore, type JobHandlers } from "@teamplanet/queue";

export type Bindings = { DB: D1Database; WORK_QUEUE: Queue<QueueEnvelope>; DEAD_LETTER_QUEUE: Queue<QueueEnvelope> };

// Analysis stays unregistered until its consent/ownership-aware handler exists (#16).
export function createHandlers(db: D1Database, now: () => number = Date.now): JobHandlers {
  return {
    "system.probe": async (_job, context) => { await context.commit("probe", "synthetic-probe"); },
    // #11: the event was signature-checked and gate-checked at intake; the gate runs again here, right before writing.
    "slack.event": async (job, context) => {
      if (job.kind !== "slack.event" || await context.checkpoint("apply")) return;
      const ref = await db.prepare("SELECT * FROM slack_event_refs WHERE event_ref = ? AND workspace_id = ? AND event_id = ?")
        .bind(job.eventRef, job.workspaceId, job.eventId).first<EventRefRow>();
      if (!ref) throw new JobError("REFERENCE_NOT_FOUND", false);
      const at = now();
      const { outcome, writes } = await planEvent(db, ref, at);
      await context.commit("apply", outcome, [
        ...writes,
        db.prepare("UPDATE slack_event_refs SET outcome = ?, processed_at = ? WHERE event_ref = ?").bind(outcome, at, ref.event_ref),
      ]);
    },
  };
}
export default {
  async queue(batch, env) {
    const store = new JobStore(env.DB);
    const handlers = createHandlers(env.DB);
    await Promise.all(batch.messages.map(message => consumeMessage(message, store, env.DEAD_LETTER_QUEUE, handlers)));
  },
  async scheduled(_event, env) { await flushOutbox(new JobStore(env.DB), env.WORK_QUEUE, env.DEAD_LETTER_QUEUE); },
} satisfies ExportedHandler<Bindings>;
