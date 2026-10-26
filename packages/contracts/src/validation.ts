import { z } from "zod";
import { competencyKeys } from "./keys";
import { dateTimeSchema, studentIdSchema, teamIdSchema } from "./api";

// Validates only the existing assessment contract; stage output schemas belong to #16.
export const competencyKeySchema = z.enum(competencyKeys);
const evidenceIdSchema = z.string().regex(/^evidence_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const competencyAssessmentSchema = z.strictObject({
  studentId: studentIdSchema,
  key: competencyKeySchema,
  judgement: z.enum(["observed_strength", "mixed", "needs_support", "insufficient_evidence"]),
  narrative: z.string().min(1), evidenceIds: z.array(evidenceIdSchema), counterEvidenceIds: z.array(evidenceIdSchema),
  confidence: z.enum(["low", "medium", "high"]), limitations: z.array(z.string().min(1)), requiresHumanReview: z.boolean(),
});
export const analysisRunRequestSchema = z.strictObject({
  teamId: teamIdSchema, from: dateTimeSchema, to: dateTimeSchema,
}).refine(value => value.from < value.to, { path: ["to"], message: "to must be after from" });
