import { z } from "zod";
import { dateTimeSchema, professorIdSchema, studentIdSchema } from "./api";
import { competencyAssessmentSchema, competencyKeySchema } from "./validation";
import { evidenceIdSchema, hashSchema, runIdSchema } from "./analysis";
export const professorDecisionSchema = z.strictObject({ studentId: studentIdSchema, key: competencyKeySchema,
  judgement: competencyAssessmentSchema.shape.judgement, narrative: z.string().trim().min(1).max(4000), reason: z.string().trim().min(1).max(1000) });
export const finalizeRequestSchema = z.strictObject({ requestId: z.uuidv4(), expectedRunVersion: z.number().int().positive(), artifactHash: hashSchema,
  decisions: z.array(professorDecisionSchema).min(1), reviewedStudentIds: z.array(studentIdSchema), reviewedEvidenceIds: z.array(evidenceIdSchema),
  reviewedIssueIds: z.array(z.string()), limitationsReviewed: z.literal(true), finalDecisionConfirmed: z.literal(true) });
export const professorFinalizationSchema = z.strictObject({ runId: runIdSchema, runVersion: z.number().int().positive(), artifactHash: hashSchema,
  professorId: professorIdSchema, confirmedAt: dateTimeSchema, requestId: z.uuidv4(), decisions: z.array(professorDecisionSchema),
  assessments: z.array(competencyAssessmentSchema), reviewedStudentIds: z.array(studentIdSchema), reviewedEvidenceIds: z.array(evidenceIdSchema), reviewedIssueIds: z.array(z.string()) });
export const finalizationResponseSchema = z.strictObject({ runId: runIdSchema, verifiedAt: dateTimeSchema, finalization: professorFinalizationSchema.nullable() });
export type ProfessorFinalization = z.infer<typeof professorFinalizationSchema>;
