import type { D1Database, ExportedHandler, Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import { consumeMessage, flushOutbox, JobStore, type JobHandlers } from "@teamplanet/queue";

export type Bindings = { DB: D1Database; WORK_QUEUE: Queue<QueueEnvelope>; DEAD_LETTER_QUEUE: Queue<QueueEnvelope> };
// Slack and analysis are deliberately unregistered until their consent/ownership-aware handlers exist.
export const handlers: JobHandlers = {
  "system.probe": async (_job, context) => { await context.commit("probe", "synthetic-probe"); },
};
export default {
  async queue(batch, env) {
    const store = new JobStore(env.DB);
    await Promise.all(batch.messages.map(message => consumeMessage(message, store, env.DEAD_LETTER_QUEUE, handlers)));
  },
  async scheduled(_event, env) { await flushOutbox(new JobStore(env.DB), env.WORK_QUEUE, env.DEAD_LETTER_QUEUE); },
} satisfies ExportedHandler<Bindings>;
