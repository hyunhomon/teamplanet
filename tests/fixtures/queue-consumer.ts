import type { ExportedHandler } from "@cloudflare/workers-types";
import { jobKey, queueEnvelopeSchema } from "@teamplanet/contracts";
import consumer, { type Bindings } from "../../apps/consumer/src/index";

// Instrument only the local test: prove duplicate delivery was consumed, without assuming FIFO.
export default {
  ...consumer,
  async queue(batch, env) {
    await consumer.queue(batch, env);
    for (const message of batch.messages) {
      const parsed = queueEnvelopeSchema.safeParse(message.body);
      await env.DB.prepare("INSERT INTO synthetic_deliveries (message_id, job_key) VALUES (?, ?) ON CONFLICT DO NOTHING")
        .bind(message.id, parsed.success ? jobKey(parsed.data.job) : "invalid").run();
    }
  },
} satisfies ExportedHandler<Bindings>;
