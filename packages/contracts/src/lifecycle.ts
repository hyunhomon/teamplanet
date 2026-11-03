import { z } from "zod";
import { dateTimeSchema, teamIdSchema } from "./api";
export const erasureRequestSchema = z.strictObject({ reason: z.literal("request") });
export const invalidationRequestSchema = z.strictObject({ reason: z.enum(["summary_mismatch", "source_unverified"]) });
export const erasureRetrySchema = z.strictObject({});
export const dataStatusSchema = z.strictObject({
  teamId: teamIdSchema, epoch: z.number().int().nonnegative(), blockedAt: dateTimeSchema.nullable(), purgedAt: dateTimeSchema.nullable(),
  invalidatedRuns: z.number().int().nonnegative(),
  erasure: z.strictObject({ id: z.string(), status: z.enum(["pending","processing","completed","failed"]),
    attempts: z.number().int().nonnegative(), completedAt: dateTimeSchema.nullable(), errorCode: z.literal("ERASURE_FAILED").nullable() }).nullable(),
});
