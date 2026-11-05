import { createHandlers, type Bindings } from "../../apps/consumer/src/index";
import { consumeMessage, JobStore } from "@teamplanet/queue";
import { queueEnvelopeSchema } from "@teamplanet/contracts";
// Same production handlers/lease runner; only the clock is injected. Native Queue/D1 remain real.
export default { async queue(batch: any, env: Bindings) {
  await env.DB.prepare("INSERT INTO e2e_deliveries (id) VALUES (?)").bind(crypto.randomUUID()).run();
  for (const message of batch.messages) {
    const parsed = queueEnvelopeSchema.safeParse(message.body);
    if (!parsed.success) console.error("Synthetic Queue schema rejection",JSON.stringify(parsed.error.issues));
  }
  const at = Number(await (await fetch("https://synthetic.invalid/clock")).text()), now = () => at;
  const handlers = createHandlers(env.DB, now, { tokenKey: env.SLACK_TOKEN_KEY, apiKey: env.OPENROUTER_API_KEY,
    models: { evidence: env.OPENROUTER_MODEL_EVIDENCE!, assessor: env.OPENROUTER_MODEL_ASSESSOR!, reviewer: env.OPENROUTER_MODEL_REVIEWER! } });
  await Promise.all(batch.messages.map((message: any) => consumeMessage(message, new JobStore(env.DB, now), env.DEAD_LETTER_QUEUE, handlers)));
} };
