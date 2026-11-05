import { z } from "zod";
import { dateTimeSchema, studentIdSchema } from "./api";
import { hashSchema, runIdSchema } from "./analysis";
import { competencyAssessmentSchema } from "./validation";
export const studentReportSchema = z.strictObject({ runId: runIdSchema, studentId: studentIdSchema, studentDisplayName: z.string(), courseName: z.string(),
  runVersion: z.number().int().positive(), artifactHash: hashSchema, rubricVersion: z.literal("communication-v1"), from: dateTimeSchema, to: dateTimeSchema,
  verifiedAt: dateTimeSchema, professorConfirmedAt: dateTimeSchema, overview: z.string(), overviewLimitations: z.array(z.string()),
  cards: z.array(z.strictObject({ key: competencyAssessmentSchema.shape.key, judgement: competencyAssessmentSchema.shape.judgement, narrative: z.string(), reason: z.string(),
    aiJudgement: competencyAssessmentSchema.shape.judgement, aiConfidence: competencyAssessmentSchema.shape.confidence,
    limitations: z.array(z.string()), aiRequestedHumanReview: z.boolean(),
    evidence: z.array(z.strictObject({ kind: z.enum(["support", "counter"]), summary: z.string(), limitations: z.array(z.string()) })) })),
  unresolvedIssues: z.array(z.string()), reviewLimitations: z.array(z.string()), purpose: z.string(), correctionNotice: z.string() });
export const printStudentReportSchema = z.strictObject({ artifactHash: hashSchema, professorConfirmedAt: dateTimeSchema, privacyReviewed: z.literal(true), requestId: z.uuidv4() });
export type StudentReport = z.infer<typeof studentReportSchema>;
