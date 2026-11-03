import { z } from "zod";
import { dateTimeSchema, studentIdSchema, teamIdSchema } from "./api";
import { rubricSelectionSchema, assessmentSetSchema } from "./rubric";
import { competencyAssessmentSchema, competencyKeySchema } from "./validation";
export const analysisContractVersion = "analysis-stages-v1" as const;
export const manifestVersion = "dataset-manifest-v1" as const;
const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
export const runIdSchema = id("run"), sourceIdSchema = id("message"), evidenceIdSchema = id("evidence"), imageIdSchema = id("image");
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const createAnalysisRunSchema = z.strictObject({ teamId: teamIdSchema, from: dateTimeSchema, to: dateTimeSchema,
  timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Unknown timezone"),
  idempotencyKey: z.uuidv4(),
}).refine(value => Date.parse(value.from) < Date.parse(value.to), { path: ["to"], message: "to must follow from" });
export const analysisStatuses = ["queued", "collecting", "evidence_extraction", "assessment", "review", "awaiting_professor", "finalized",
  "blocked_provider_billing", "failed_provider_auth", "rate_limited", "failed_model", "failed_data", "cancelled"] as const;
export const analysisStatusSchema = z.enum(analysisStatuses);
export const analysisErrorSchema = z.strictObject({ code: z.enum(["DATA_INVALIDATED", "SOURCE_UNAVAILABLE", "HANDLER_UNREGISTERED", "CONTEXT_LIMIT", "STAGE_INVALID", "PROVIDER_BILLING_BLOCKED", "PROVIDER_AUTH", "RATE_LIMITED", "MODEL_INVALID", "JOB_FAILED"]), retryable: z.boolean() });
export const analysisSnapshotSchema = z.strictObject({ contractVersion: z.literal(analysisContractVersion), rubric: rubricSelectionSchema,
  modelProfileVersion: z.literal("qwen-pilot-v1"), promptVersion: z.literal("communication-prompts-v1"),
  configuredModel: z.literal("qwen/qwen3.5-9b"), configuredProvider: z.literal("deepinfra/bf16"),
  contextPlanVersion: z.literal("qwen-chunks-v1"), contextLength: z.literal(262144), maxTextBytes: z.literal(48000), maxImagesPerChunk: z.literal(1),
});
export const partSchema = z.strictObject({ id: z.string().regex(/^part_[0-9a-f-]{36}_[0-9]+$/), messageId: sourceIdSchema,
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), utf8Bytes: z.number().int().nonnegative(),
  imageIds: z.array(imageIdSchema), threadId: sourceIdSchema.nullable(), limitations: z.array(z.string().max(200)),
}).refine(p => p.start <= p.end);
export const chunkPlanSchema = z.strictObject({ id: z.string().regex(/^chunk_[0-9]+$/), parts: z.array(partSchema).min(1),
  context: z.array(partSchema), limitations: z.array(z.string().max(200)) });
export const manifestHeaderSchema = z.strictObject({ version: z.literal(manifestVersion), hash: hashSchema, epoch: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(), partCount: z.number().int().nonnegative(), chunkCount: z.number().int().nonnegative(),
  coverageRequestId: z.uuidv4(), coverageAsOf: dateTimeSchema, limitations: z.array(z.string()) });
export const analysisRunResponseSchema = z.strictObject({ id: runIdSchema, teamId: teamIdSchema, from: dateTimeSchema, to: dateTimeSchema,
  timezone: z.string(), status: analysisStatusSchema, snapshot: analysisSnapshotSchema, manifest: manifestHeaderSchema.nullable(),
  valid: z.boolean(), progress: z.strictObject({ sources: z.number().int().nonnegative(), chunks: z.number().int().nonnegative(), completedChunks: z.number().int().nonnegative() }),
  errors: z.array(analysisErrorSchema), version: z.number().int().positive() });

export const memoryPartSchema = z.strictObject({ ...partSchema.shape, text: z.string(), studentId: studentIdSchema, sentAt: dateTimeSchema,
  images: z.array(z.strictObject({ id: imageIdSchema, dataUrl: z.string().startsWith("data:image/"), studentId: studentIdSchema.nullable(), limitations: z.array(z.string()) })) })
  .refine(p => p.end >= p.start && p.text.length === p.end - p.start && new TextEncoder().encode(p.text).length === p.utf8Bytes, "Source part range/bytes mismatch");
export const analysisContextSchema = z.strictObject({ version: z.literal(analysisContractVersion), runId: runIdSchema, selection: rubricSelectionSchema,
  students: z.array(z.strictObject({ id: studentIdSchema, displayName: z.string().min(1).max(200) })).min(1), parts: z.array(memoryPartSchema), limitations: z.array(z.string()),
  period: z.strictObject({ from: dateTimeSchema, to: dateTimeSchema, timezone: z.string() }) });
export const evidenceInputSchema = analysisContextSchema.extend({ chunkId: z.string().regex(/^chunk_[0-9]+$/), primaryPartIds: z.array(z.string()).min(1) });
const rawCitation = z.strictObject({ partId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1).max(4000) });
export const evidenceModelOutputSchema = z.strictObject({ version: z.literal(analysisContractVersion), processedPartIds: z.array(z.string()),
  events: z.array(z.strictObject({ messageIds: z.array(sourceIdSchema).min(1), actorIds: z.array(studentIdSchema),
    summary: z.string().min(1).max(1000), behaviorTags: z.array(competencyKeySchema), modality: z.enum(["text", "image", "mixed"]),
    citations: z.array(rawCitation), imageCitations: z.array(z.strictObject({ partId: z.string(), imageId: imageIdSchema, observation: z.string().min(1).max(1000), actorId: studentIdSchema.nullable() })),
    limitations: z.array(z.string().min(1).max(300)), requiresHumanReview: z.boolean() })), limitations: z.array(z.string().max(300)) });
export const normalizedEvidenceSchema = z.strictObject({ id: evidenceIdSchema, messageIds: z.array(sourceIdSchema).min(1), actorIds: z.array(studentIdSchema),
  summary: z.string().min(1).max(1000), behaviorTags: z.array(competencyKeySchema), modality: z.enum(["text", "image", "mixed"]),
  citations: z.array(z.strictObject({ messageId: sourceIdSchema, start: z.number().int().nonnegative(), end: z.number().int().positive(), hash: hashSchema })),
  imageIds: z.array(imageIdSchema), limitations: z.array(z.string()), requiresHumanReview: z.boolean() });
export const assessmentOutputSchema = z.strictObject({ version: z.literal(analysisContractVersion), runId: runIdSchema,
  overviews: z.array(z.strictObject({ studentId: studentIdSchema, summary: z.string().min(1).max(1000), limitations: z.array(z.string()), requiresHumanReview: z.boolean() })),
  assessments: z.array(competencyAssessmentSchema) });
export const assessmentInputSchema = analysisContextSchema.extend({ evidence: z.array(normalizedEvidenceSchema), correction: z.strictObject({ iteration: z.literal(1), issues: z.array(z.lazy(() => reviewIssueSchema)).min(1) }).nullable() });
export const reviewIssueSchema = z.strictObject({ id: z.string().regex(/^issue_[A-Za-z0-9_-]{1,80}$/),
  code: z.enum(["unsupported_claim", "counterevidence_missing", "activity_bias", "overgeneralization", "uncertainty_missing", "context_missing"]),
  studentId: studentIdSchema, competency: competencyKeySchema, evidenceIds: z.array(evidenceIdSchema), messageIds: z.array(sourceIdSchema),
  instruction: z.string().min(1).max(1000) });
export const reviewOutputSchema = z.strictObject({ version: z.literal(analysisContractVersion), runId: runIdSchema, iteration: z.union([z.literal(0), z.literal(1)]),
  decision: z.enum(["accept", "request_correction", "human_review"]), issues: z.array(reviewIssueSchema), limitations: z.array(z.string()), requiresHumanReview: z.boolean() });
export const reviewInputSchema = assessmentInputSchema.extend({ assessment: assessmentOutputSchema, iteration: z.union([z.literal(0), z.literal(1)]) });
export const correctionOutputSchema = z.strictObject({ version: z.literal(analysisContractVersion), iteration: z.literal(1), resolvedIssueIds: z.array(z.string()), assessment: assessmentOutputSchema });

export function validateEvidenceOutput(raw: unknown, value: unknown) {
  const input = evidenceInputSchema.parse(value), out = evidenceModelOutputSchema.parse(raw);
  const parts = new Map(input.parts.map(p => [p.id, p])), students = new Set(input.students.map(s => s.id));
  if (parts.size !== input.parts.length || input.primaryPartIds.some(id => !parts.has(id)) || input.parts.some(p => !students.has(p.studentId))) throw new Error("STAGE_INPUT_INVALID");
  if (new Set(out.processedPartIds).size !== out.processedPartIds.length || [...input.primaryPartIds].sort().join() !== [...out.processedPartIds].sort().join()) throw new Error("STAGE_COVERAGE_INVALID");
  for (const event of out.events) {
    const messages = new Set<string>(), actors = new Set<string>();
    if (new Set(event.messageIds).size !== event.messageIds.length || new Set(event.actorIds).size !== event.actorIds.length || new Set(event.behaviorTags).size !== event.behaviorTags.length) throw new Error("STAGE_DUPLICATE_REFERENCE");
    for (const citation of event.citations) {
      const p = parts.get(citation.partId);
      if (!p || citation.start < p.start || citation.end > p.end || citation.start >= citation.end || p.text.slice(citation.start - p.start, citation.end - p.start) !== citation.quote) throw new Error("STAGE_CITATION_INVALID");
      messages.add(p.messageId); actors.add(p.studentId);
    }
    for (const citation of event.imageCitations) {
      const p = parts.get(citation.partId), image = p?.images.find(i => i.id === citation.imageId);
      if (!p || !image || (citation.actorId !== null && citation.actorId !== image.studentId)) throw new Error("STAGE_IMAGE_ACTOR_INVALID");
      if (image.studentId === null && (!event.requiresHumanReview || event.limitations.length === 0)) throw new Error("STAGE_IMAGE_UNCERTAIN");
      messages.add(p.messageId); if (citation.actorId) actors.add(citation.actorId);
    }
    if (messages.size !== event.messageIds.length || event.messageIds.some(id => !messages.has(id)) || event.actorIds.some(id => !students.has(id) || !actors.has(id))) throw new Error("STAGE_REFERENCE_INVALID");
    if (event.behaviorTags.some(key => !input.selection.selectedCompetencies.includes(key))) throw new Error("STAGE_UNSELECTED_COMPETENCY");
    if (!event.actorIds.length && (!event.requiresHumanReview || !event.limitations.length || event.behaviorTags.length)) throw new Error("STAGE_ACTOR_UNKNOWN");
    if (event.modality === "text" && event.imageCitations.length || event.modality === "image" && !event.imageCitations.length || event.modality === "mixed" && (!event.imageCitations.length || !event.citations.length)) throw new Error("STAGE_MODALITY_INVALID");
  }
  return out;
}
export function validateAssessmentOutput(raw: unknown, value: unknown) {
  const input = assessmentInputSchema.parse(value), out = assessmentOutputSchema.parse(raw);
  if (out.runId !== input.runId) throw new Error("STAGE_RUN_INVALID");
  assessmentSetSchema(input.selection, input.students.map(s => s.id), input.evidence.map(e => e.id)).parse(out.assessments);
  if (out.overviews.length !== input.students.length || new Set(out.overviews.map(s => s.studentId)).size !== input.students.length || out.overviews.some(s => !input.students.some(p => p.id === s.studentId))) throw new Error("STAGE_STUDENT_MISSING");
  for (const row of out.assessments) for (const ref of [...row.evidenceIds, ...row.counterEvidenceIds]) {
    const e = input.evidence.find(e => e.id === ref)!;
    if (!e.actorIds.includes(row.studentId) || !e.behaviorTags.includes(row.key)) throw new Error("STAGE_ACTOR_EVIDENCE_INVALID");
  }
  return out;
}
export function validateReviewOutput(raw: unknown, value: unknown) {
  const input = reviewInputSchema.parse(value), out = reviewOutputSchema.parse(raw);
  const { assessment, iteration, ...assessmentInput } = input;
  validateAssessmentOutput(assessment, assessmentInput);
  if (out.runId !== input.runId || out.iteration !== input.iteration || new Set(out.issues.map(i => i.id)).size !== out.issues.length) throw new Error("STAGE_REVIEW_INVALID");
  if (out.decision === "accept" && out.issues.length || out.decision === "request_correction" && (!out.issues.length || out.iteration !== 0) || out.decision === "human_review" && !out.requiresHumanReview) throw new Error("STAGE_CORRECTION_LIMIT");
  for (const issue of out.issues) if (!input.students.some(s => s.id === issue.studentId) || !input.selection.selectedCompetencies.includes(issue.competency)
    || issue.evidenceIds.some(id => !input.evidence.some(e => e.id === id)) || issue.messageIds.some(id => !input.parts.some(p => p.messageId === id))) throw new Error("STAGE_REVIEW_REFERENCE_INVALID");
  return out;
}
export function validateCorrectionOutput(raw: unknown, value: unknown, review: unknown) {
  const input = assessmentInputSchema.parse(value), correction = correctionOutputSchema.parse(raw), request = reviewOutputSchema.parse(review);
  if (request.runId !== input.runId || request.iteration !== 0 || request.decision !== "request_correction"
    || [...correction.resolvedIssueIds].sort().join() !== request.issues.map(i => i.id).sort().join()) throw new Error("STAGE_CORRECTION_INVALID");
  validateAssessmentOutput(correction.assessment, input); return correction;
}
export const allowedAnalysisTransitions: Record<string, readonly string[]> = {
  queued: ["collecting", "cancelled", "failed_data"], collecting: ["evidence_extraction", "cancelled", "failed_data", "failed_model"],
  evidence_extraction: ["assessment", "cancelled", "failed_data", "failed_model", "blocked_provider_billing", "failed_provider_auth", "rate_limited"],
  assessment: ["review", "cancelled", "failed_data", "failed_model", "blocked_provider_billing", "failed_provider_auth", "rate_limited"],
  review: ["assessment", "awaiting_professor", "cancelled", "failed_data", "failed_model", "blocked_provider_billing", "failed_provider_auth", "rate_limited"],
};
export function assertAnalysisTransition(from: string, to: string, proof: { valid: boolean; completed: boolean; correctionIteration?: number }) {
  if (!allowedAnalysisTransitions[from]?.includes(to)) throw new Error("STAGE_TRANSITION_INVALID");
  if (!["failed_data", "cancelled"].includes(to) && !proof.valid) throw new Error("DATA_INVALIDATED");
  if (["evidence_extraction", "assessment", "review", "awaiting_professor"].includes(to) && !proof.completed) throw new Error("STAGE_INCOMPLETE");
  if (from === "review" && to === "assessment" && proof.correctionIteration !== 1) throw new Error("STAGE_CORRECTION_LIMIT");
}
export type AnalysisSnapshot = z.infer<typeof analysisSnapshotSchema>;
export type ChunkPlan = z.infer<typeof chunkPlanSchema>;
export type Part = z.infer<typeof partSchema>;
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export type NormalizedEvidence = z.infer<typeof normalizedEvidenceSchema>;
export const evidenceOutputJsonSchema = z.toJSONSchema(evidenceModelOutputSchema);
