import type { D1Database, ExportedHandler, Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import { planEvent, recoverHistory, sweepDataRetention, sweepInquiries, type EventRefRow, type SlackFetch } from "@teamplanet/collection";
import { consumeMessage, flushOutbox, JobError, JobStore, type JobHandlers } from "@teamplanet/queue";
import { prepareAnalysis, processAnalysisStage, type PipelineDeps } from "@teamplanet/analysis";

export type Bindings = {
  DB: D1Database; WORK_QUEUE: Queue<QueueEnvelope>; DEAD_LETTER_QUEUE: Queue<QueueEnvelope>;
  SLACK_TOKEN_KEY?: string; // same secret as the API's; History recovery (#12) opens the bot token with it
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL_EVIDENCE?: string; OPENROUTER_MODEL_ASSESSOR?: string; OPENROUTER_MODEL_REVIEWER?: string;
};
type SlackDeps = { send?: SlackFetch; tokenKey?: string } & Pick<PipelineDeps, "apiKey" | "models" | "fetcher">;

// Authorized reference preparation and pinned A/B/C stages share the same production Queue/D1.
export function createHandlers(db: D1Database, now: () => number = Date.now, slack: SlackDeps = {}): JobHandlers {
  const deps = { ...slack, db, now, send: slack.send ?? ((url: string, init: RequestInit) => fetch(url, init)) };
  return {
    "analysis.stage": async (job, context) => {
      if (job.kind === "analysis.stage") await processAnalysisStage(deps, job, context);
    },
    "analysis.prepare": async (job, context) => {
      if (job.kind !== "analysis.prepare") return;
      await prepareAnalysis(deps, job.runId, context);
    },
    "system.probe": async (_job, context) => { await context.commit("probe", "synthetic-probe"); },
    "slack.history": async (job, context) => {
      if (job.kind !== "slack.history") return;
      await recoverHistory({ db, now, send: slack.send ?? ((url, init) => fetch(url, init)), tokenKey: slack.tokenKey }, job, context);
    },
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
    const handlers = createHandlers(env.DB, Date.now, { tokenKey: env.SLACK_TOKEN_KEY, apiKey: env.OPENROUTER_API_KEY,
      models: { evidence: env.OPENROUTER_MODEL_EVIDENCE ?? "", assessor: env.OPENROUTER_MODEL_ASSESSOR ?? "", reviewer: env.OPENROUTER_MODEL_REVIEWER ?? "" } });
    await Promise.all(batch.messages.map(message => consumeMessage(message, store, env.DEAD_LETTER_QUEUE, handlers)));
  },
  async scheduled(_event, env) {
    const results = await Promise.allSettled([sweepDataRetention(env.DB, Date.now()), sweepInquiries(env.DB, Date.now()),
      flushOutbox(new JobStore(env.DB), env.WORK_QUEUE, env.DEAD_LETTER_QUEUE)]);
    if (results.some(result => result.status === "rejected")) throw new Error("SCHEDULED_WORK_INCOMPLETE");
  },
} satisfies ExportedHandler<Bindings>;
