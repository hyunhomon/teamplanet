import { assessmentInputSchema, correctionOutputSchema, reviewInputSchema, reviewOutputJsonSchema,
  validateAssessmentOutput, validateCorrectionOutput, validateReviewOutput } from "@teamplanet/contracts";
import { sha256Hex } from "@teamplanet/collection";
import { modelProfile } from "@teamplanet/ai-core";
import { EvidenceError, requestStage, verifyEvidenceGeneration, type EvidenceModelDeps, type EvidenceReceipt } from "./evidence";
import { reviewerPromptVersion, reviewerSystemPrompt } from "./reviewer-prompt";
export { reviewerPromptVersion, reviewerSystemPrompt } from "./reviewer-prompt";
export type ReviewInput = ReturnType<typeof reviewInputSchema.parse>;
export type ReviewOutput = ReturnType<typeof validateReviewOutput>;
export type ReviewResult = { runId: string; iteration: 0 | 1; review: ReviewOutput; receipt: EvidenceReceipt };
const distinct = (values: string[]) => [...new Set(values)].sort();
const invalid = () => { throw new EvidenceError("MODEL_INVALID"); };
const assessmentInput = ({ assessment, iteration, ...rest }: ReviewInput) => assessmentInputSchema.parse(rest);
function candidateFor(input: ReviewInput, review: ReviewOutput) {
  const candidate = structuredClone(input.assessment);
  for (const row of [...candidate.assessments, ...candidate.overviews]) {
    row.requiresHumanReview ||= review.requiresHumanReview;
    row.limitations = distinct([...row.limitations, ...review.limitations]);
  }
  return candidate;
}

/** Resolve offsets across split/overlapping parts without trusting A's summary or hash alone. */
async function checkSources(input: ReviewInput) {
  const students = new Set(input.students.map(s => s.id));
  if (students.size !== input.students.length || new Set(input.parts.map(p => p.id)).size !== input.parts.length
    || new Set(input.evidence.map(e => e.id)).size !== input.evidence.length || input.parts.some(p => !students.has(p.studentId))) invalid();
  for (const event of input.evidence) {
    const parts = input.parts.filter(p => event.messageIds.includes(p.messageId));
    if (event.messageIds.some(id => !parts.some(p => p.messageId === id)) || event.behaviorTags.some(k => !input.selection.selectedCompetencies.includes(k))
      || new Set(event.messageIds).size !== event.messageIds.length || new Set(event.actorIds).size !== event.actorIds.length) invalid();
    const authors = new Set<string>();
    for (const c of event.citations) {
      let text = "";
      const matching = parts.filter(p => p.messageId === c.messageId).sort((a, b) => a.start - b.start);
      if (!matching.length || new Set(matching.map(p => p.studentId)).size !== 1) throw new EvidenceError("DATA_INVALIDATED");
      for (const p of matching) {
        const start = c.start + text.length;
        if (p.end <= start || p.start >= c.end) continue;
        if (p.start > start) break;
        text += p.text.slice(start - p.start, Math.min(c.end, p.end) - p.start);
      }
      if (c.end <= c.start || text.length !== c.end - c.start || await sha256Hex(text) !== c.hash) throw new EvidenceError("DATA_INVALIDATED");
      authors.add(matching[0]!.studentId);
    }
    for (const id of event.imageIds) {
      const image = parts.flatMap(p => p.images).find(i => i.id === id);
      if (!image || !parts.some(p => p.imageIds.includes(id))) throw new EvidenceError("DATA_INVALIDATED");
      if (image.studentId) authors.add(image.studentId);
      else if (!event.requiresHumanReview || !event.limitations.length) invalid();
    }
    if (event.actorIds.some(id => !students.has(id) || !authors.has(id))) throw new EvidenceError("DATA_INVALIDATED");
    if (!event.citations.length && !event.imageIds.length) invalid();
  }
}

/** C's references must support THIS student/dimension, not merely be IDs found somewhere in the input. */
function checkedReview(raw: unknown, input: ReviewInput): ReviewOutput {
  let out: ReviewOutput;
  try { out = validateReviewOutput(raw, input); } catch { return invalid(); }
  for (const issue of out.issues) {
    if (!issue.evidenceIds.length && !issue.messageIds.length || new Set(issue.evidenceIds).size !== issue.evidenceIds.length
      || new Set(issue.messageIds).size !== issue.messageIds.length) invalid();
    const evidence = issue.evidenceIds.map(id => input.evidence.find(e => e.id === id)!);
    if (evidence.some(e => !e.actorIds.includes(issue.studentId) || !e.behaviorTags.includes(issue.competency))) invalid();
    if (issue.messageIds.some(id => !evidence.some(e => e.messageIds.includes(id)) && !input.parts.some(p => p.messageId === id && p.studentId === issue.studentId))) invalid();
  }
  // A review may describe an error, but may not persist a raw quotation as its correction.
  for (const text of [...out.limitations, ...out.issues.map(i => i.instruction)]) {
    if (text.length > 2000) invalid();
    for (const p of input.parts) {
      if (p.text.length >= 12 && text.includes(p.text)) invalid();
      for (let i = 0; i + 32 <= text.length; i++) if (p.text.includes(text.slice(i, i + 32))) invalid();
    }
  }
  out.limitations = distinct([...out.limitations, ...input.limitations, ...input.evidence.flatMap(e => e.limitations),
    ...input.assessment.overviews.flatMap(o => o.limitations), ...input.assessment.assessments.flatMap(a => a.limitations)]);
  out.requiresHumanReview ||= out.decision !== "accept" || input.evidence.some(e => e.requiresHumanReview)
    || input.assessment.overviews.some(o => o.requiresHumanReview) || input.assessment.assessments.some(a => a.requiresHumanReview);
  return out;
}

/** A single separate C call. No automatic provider retry, B dependency, database write or grade finalization. */
export async function reviewAssessment(deps: EvidenceModelDeps, value: unknown, assertCurrent: () => Promise<void>): Promise<ReviewResult> {
  if (!deps.apiKey?.trim() || deps.modelId !== modelProfile.model) throw new EvidenceError("CONFIG_INVALID");
  let input: ReviewInput;
  try { input = reviewInputSchema.parse(value); validateAssessmentOutput(input.assessment, assessmentInput(input)); }
  catch { throw new EvidenceError("MODEL_INVALID"); }
  if (input.iteration === 0 && input.correction !== null || input.iteration === 1 && input.correction === null) invalid();
  if (input.correction) checkedReview({ version: input.version, runId: input.runId, iteration: 0, decision: "request_correction",
    issues: input.correction.issues, limitations: [], requiresHumanReview: true }, { ...input, iteration: 0, correction: null });
  await checkSources(input);
  // All primary text and context are retained. Image bytes stay transient with A, never serialized as text.
  const data = JSON.stringify({ ...input, parts: input.parts.map(({ images, ...p }) => ({ ...p,
    images: images.map(({ dataUrl, ...metadata }) => metadata) })) });
  if (new TextEncoder().encode(data).length > 150000) throw new EvidenceError("CONTEXT_LIMIT");
  const current = async () => { try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); } };
  await current();
  const { generationId, content } = await requestStage(deps, [{ role: "system", content: reviewerSystemPrompt }, { role: "user", content: data }], "teamplanet_review_v1", reviewOutputJsonSchema);
  let raw: unknown; try { raw = JSON.parse(content); } catch { return invalid(); }
  const review = checkedReview(raw, input);
  if (deps.onValidated) { await current(); await deps.onValidated({ runId: input.runId, iteration: input.iteration, review }, generationId); }
  const receipt = await verifyEvidenceGeneration(deps, generationId, deps.modelId);
  await current();
  return { runId: input.runId, iteration: input.iteration, review, receipt };
}

/** Pure, bounded reconciliation. Persist this history with the same run-validity fence in #20. */
export async function reconcileReview(value: unknown, first: unknown, correction?: unknown, second?: unknown) {
  const input = reviewInputSchema.parse(value);
  if (input.iteration !== 0 || input.correction !== null) invalid();
  await checkSources(input);
  const originalAssessment = structuredClone(input.assessment), firstReview = checkedReview(first, input);
  if (firstReview.decision !== "request_correction") {
    if (correction !== undefined || second !== undefined) invalid();
    return { originalAssessment, firstReview, correction: null, finalReview: firstReview, candidate: candidateFor(input, firstReview),
      next: "awaiting_professor" as const, requiresHumanReview: firstReview.requiresHumanReview };
  }
  if (correction === undefined) {
    if (second !== undefined) invalid();
    return { originalAssessment, firstReview, correction: null, finalReview: null, candidate: null,
      next: "needs_correction" as const, requiresHumanReview: true };
  }
  const correctedInput = { ...input, correction: { iteration: 1 as const, issues: firstReview.issues } };
  let fixed: ReturnType<typeof correctionOutputSchema.parse>;
  try { fixed = validateCorrectionOutput(correction, assessmentInput(correctedInput), firstReview); }
  catch { return invalid(); }
  if (second === undefined) invalid();
  const finalReview = checkedReview(second, { ...correctedInput, iteration: 1, assessment: fixed.assessment });
  // The correction may change the judgement, but must not erase the original B uncertainty.
  const originalRows = [...input.assessment.overviews, ...input.assessment.assessments];
  finalReview.limitations = distinct([...finalReview.limitations, ...originalRows.flatMap(row => row.limitations)]);
  finalReview.requiresHumanReview ||= originalRows.some(row => row.requiresHumanReview);
  const candidate = candidateFor({ ...correctedInput, iteration: 1, assessment: fixed.assessment }, finalReview);
  return { originalAssessment, firstReview, correction: structuredClone(fixed), finalReview, candidate,
    next: "awaiting_professor" as const, requiresHumanReview: finalReview.requiresHumanReview };
}
