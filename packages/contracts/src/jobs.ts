import { z } from "zod";
import { workspaceIdSchema } from "./api";

const uuid = z.uuidv4();
const resourceId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
export const queueJobSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("system.probe"), probeId: uuid }),
  z.strictObject({
    kind: z.literal("slack.event"), workspaceId: workspaceIdSchema,
    eventId: z.string().regex(/^Ev[A-Z0-9]{6,}$/),
    eventRef: resourceId("event"),
  }),
  z.strictObject({
    kind: z.literal("analysis.stage"), runId: resourceId("run"),
    stage: z.enum(["collecting", "evidence_extraction", "assessment", "review"]),
    chunkId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  }),
]);
export const queueEnvelopeSchema = z.strictObject({
  version: z.literal(1), generation: z.number().int().min(0).max(3), job: queueJobSchema,
});
export type QueueJob = z.infer<typeof queueJobSchema>;
export type QueueEnvelope = z.infer<typeof queueEnvelopeSchema>;
export const jobRecoverySchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9_:-]{1,400}$/), generation: z.number().int().min(0).max(3),
  reasonRef: z.string().regex(/^[A-Za-z0-9_:/.-]{1,200}$/),
});
export function jobKey(job: QueueJob): string {
  switch (job.kind) {
    case "system.probe": return `probe:${job.probeId}`;
    case "slack.event": return `event:${job.workspaceId}:${job.eventId}`;
    case "analysis.stage": return `run:${job.runId}:${job.stage}:${job.chunkId}`;
  }
}
