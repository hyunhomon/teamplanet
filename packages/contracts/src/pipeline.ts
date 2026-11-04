import { z } from "zod";
import { analysisErrorSchema, analysisSnapshotSchema, assessmentOutputSchema, correctionOutputSchema, manifestHeaderSchema,
  normalizedEvidenceSchema, reviewOutputSchema, runIdSchema } from "./analysis";

export const stageNameSchema = z.enum(["evidence_extraction", "assessment", "review"]);
export const stageReceiptSchema = z.strictObject({ generationId: z.string().regex(/^gen-[A-Za-z0-9_-]{1,150}$/),
  model: z.literal("qwen/qwen3.5-9b"), provider: z.literal("DeepInfra"), requestedProvider: z.literal("deepinfra/bf16"), promptVersion: z.literal("communication-prompts-v1") });
export const evidenceStageDataSchema = z.strictObject({ runId: runIdSchema, chunkId: z.string().regex(/^chunk_[0-9]+$/),
  processedPartIds: z.array(z.string()), events: z.array(normalizedEvidenceSchema), limitations: z.array(z.string()), missingImageIds: z.array(z.string()) });
export const assessmentStageDataSchema = z.strictObject({ runId: runIdSchema, iteration: z.union([z.literal(0), z.literal(1)]),
  assessment: assessmentOutputSchema, resolvedIssueIds: z.array(z.string()) });
export const reviewStageDataSchema = z.strictObject({ runId: runIdSchema, iteration: z.union([z.literal(0), z.literal(1)]), review: reviewOutputSchema });
export const pipelineErrorSchema = analysisErrorSchema.extend({ stage: stageNameSchema, chunkId: z.string() });
export const pipelineMetadataSchema = z.strictObject({ version: z.literal("pipeline-v1"), error: pipelineErrorSchema.nullable() });
export const analysisArtifactsSchema = z.strictObject({ version: z.literal("analysis-output-v1"), runId: runIdSchema,
  snapshot: analysisSnapshotSchema, manifest: manifestHeaderSchema, evidence: z.array(normalizedEvidenceSchema),
  originalAssessment: assessmentOutputSchema, firstReview: reviewOutputSchema, correction: correctionOutputSchema.nullable(),
  finalReview: reviewOutputSchema, candidate: assessmentOutputSchema, requiresHumanReview: z.boolean(), receipts: z.array(stageReceiptSchema) });
export type StageName = z.infer<typeof stageNameSchema>;
export type AnalysisArtifacts = z.infer<typeof analysisArtifactsSchema>;
