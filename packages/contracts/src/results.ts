import { z } from "zod";
import { dateTimeSchema, studentIdSchema, teamIdSchema } from "./api";
import { analysisArtifactsSchema } from "./pipeline";
import { evidenceIdSchema, hashSchema, runIdSchema, sourceIdSchema, normalizedEvidenceSchema, imageIdSchema } from "./analysis";
export const resultResponseSchema = z.strictObject({ runId: runIdSchema, teamId: teamIdSchema, status: z.enum(["awaiting_professor", "finalized"]),
  version: z.number().int().positive(), from: dateTimeSchema, to: dateTimeSchema, verifiedAt: dateTimeSchema, artifactHash: hashSchema,
  students: z.array(z.strictObject({ id: studentIdSchema, displayName: z.string() })), artifacts: analysisArtifactsSchema });
export const evidenceResponseSchema = z.strictObject({ runId: runIdSchema, verifiedAt: dateTimeSchema, evidence: normalizedEvidenceSchema });
export const messageContextSchema = z.strictObject({ runId: runIdSchema, targetId: sourceIdSchema, verifiedAt: dateTimeSchema,
  messages: z.array(z.strictObject({ id: sourceIdSchema, studentId: studentIdSchema, displayName: z.string(), sentAt: dateTimeSchema, text: z.string(),
    limitations: z.array(z.string()), images: z.array(z.strictObject({ id: imageIdSchema, available: z.literal(false), limitations: z.array(z.string()) })) })),
  nextAfter: sourceIdSchema.nullable(), limitations: z.array(z.string()) });
export const resultEvidenceParamsSchema = z.strictObject({ id: runIdSchema, evidenceId: evidenceIdSchema });
export type ResultResponse = z.infer<typeof resultResponseSchema>;
export type MessageContext = z.infer<typeof messageContextSchema>;
