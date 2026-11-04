import { assessmentInputSchema, assessmentOutputJsonSchema, competencyLabels, correctionOutputJsonSchema, validateAssessmentOutput, validateCorrectionOutput,
  type AssessmentInput, type AssessmentOutput } from "@teamplanet/contracts";
import { sha256Hex } from "@teamplanet/collection";
import { modelProfile } from "@teamplanet/ai-core";
import { checkSummary, EvidenceError, requestStage, verifyEvidenceGeneration, type EvidenceModelDeps, type EvidenceReceipt } from "./evidence";
import { assessorSystemPrompt } from "./assessor-prompt";
export { assessorPromptVersion, assessorSystemPrompt } from "./assessor-prompt";
export type AssessmentResult = { runId: string; iteration: 0 | 1; assessment: AssessmentOutput; resolvedIssueIds: string[]; receipt: EvidenceReceipt };
const distinct = (values: string[]) => [...new Set(values)].filter(Boolean).sort();
// On top of the A inference check: scores, rankings and activity-volume proxies never describe a competency.
const proxy = /점수|등급|순위|학점|말수|활동량|참여도|답장\s*수|이모지\s*수|링크\s*(?:수|개수)|\b(?:score|rank(?:ing)?)\b/i;
const candidates = (input: AssessmentInput) => input.students.flatMap(s => input.selection.selectedCompetencies.map(key => ({ studentId: s.id, key,
  evidenceIds: input.evidence.filter(e => e.actorIds.includes(s.id) && e.behaviorTags.includes(key)).map(e => e.id).sort() })));

/** Every evidence reference must trace back to the supplied source text, so stale, forged or misattributed evidence never reaches the model. */
async function traceEvidence(input: AssessmentInput) {
  const students = new Set(input.students.map(s => s.id)), selected: readonly string[] = input.selection.selectedCompetencies;
  const byMessage = new Map<string, AssessmentInput["parts"]>();
  for (const p of input.parts) byMessage.set(p.messageId, [...(byMessage.get(p.messageId) ?? []), p]);
  const slice = (messageId: string, start: number, end: number) => {
    let out = "";
    for (const p of [...byMessage.get(messageId)!].sort((a, b) => a.start - b.start)) {
      if (p.end <= start + out.length || p.start >= end) continue;
      if (p.start > start + out.length) return null;
      out += p.text.slice(start + out.length - p.start, Math.min(end, p.end) - p.start);
    }
    return out.length === end - start ? out : null;
  };
  if (new Set(input.parts.map(p => p.id)).size !== input.parts.length || input.parts.some(p => !students.has(p.studentId))
    || new Set(input.evidence.map(e => e.id)).size !== input.evidence.length) throw new EvidenceError("MODEL_INVALID");
  for (const e of input.evidence) {
    if (e.actorIds.some(id => !students.has(id)) || e.behaviorTags.some(key => !selected.includes(key))) throw new EvidenceError("MODEL_INVALID");
    const parts = input.parts.filter(p => e.messageIds.includes(p.messageId));
    if (e.messageIds.some(id => !byMessage.has(id)) || e.imageIds.some(id => !parts.some(p => p.imageIds.includes(id)))) throw new EvidenceError("DATA_INVALIDATED");
    for (const c of e.citations) {
      const quote = e.messageIds.includes(c.messageId) ? slice(c.messageId, c.start, c.end) : null;
      if (quote === null || await sha256Hex(quote) !== c.hash) throw new EvidenceError("DATA_INVALIDATED");
    }
    // An actor is the author of a cited message or the verified uploader of a supplied image; nobody else's behavior is attributed.
    const authors = new Set([...e.citations.map(c => byMessage.get(c.messageId)![0]!.studentId),
      ...parts.flatMap(p => p.images).filter(i => e.imageIds.includes(i.id)).map(i => i.studentId)]);
    if (e.actorIds.some(id => !authors.has(id))) throw new EvidenceError("DATA_INVALIDATED");
  }
}
function modelMessages(input: AssessmentInput) {
  const cited = new Set(input.evidence.flatMap(e => e.messageIds));
  const data = JSON.stringify({ version: input.version, runId: input.runId, selection: input.selection,
    rubric: input.selection.selectedCompetencies.map(key => ({ key, label: competencyLabels[key] })), students: input.students, period: input.period,
    limitations: input.limitations, correction: input.correction, evidence: input.evidence, candidates: candidates(input),
    // Only cited messages: uncited chatter (message volume) cannot move an assessment. Image bytes stay with A's verified events.
    sources: input.parts.filter(p => cited.has(p.messageId)).map(({ images, ...p }) => p) });
  if (new TextEncoder().encode(data).length > 150000) throw new EvidenceError("CONTEXT_LIMIT");
  return [{ role: "system", content: assessorSystemPrompt }, { role: "user", content: [{ type: "text", text: data }] }];
}
/** Rejects unfounded or proxy-based claims, then only ever adds limitations and review flags: B cannot hide what A or the input flagged. */
function annotate(out: AssessmentOutput, input: AssessmentInput) {
  const evidence = new Map(input.evidence.map(e => [e.id, e])), cited = new Set(input.evidence.flatMap(e => e.messageIds));
  const sources = { parts: input.parts.filter(p => cited.has(p.messageId)) }, support = input.evidence.map(e => e.summary);
  const check = (text: string) => { if (proxy.test(text)) throw new EvidenceError("MODEL_INVALID"); checkSummary(text, sources, support); };
  const expected = new Map(candidates(input).map(c => [`${c.studentId}:${c.key}`, c.evidenceIds]));
  for (const row of out.assessments) {
    check(row.narrative);
    const refs = [...row.evidenceIds, ...row.counterEvidenceIds];
    if (new Set(refs).size !== refs.length || row.judgement === "mixed" && !row.counterEvidenceIds.length) throw new EvidenceError("MODEL_INVALID");
    const used = refs.map(id => evidence.get(id)!), unaddressed = expected.get(`${row.studentId}:${row.key}`)!.filter(id => !refs.includes(id));
    row.limitations = distinct([...row.limitations, ...used.flatMap(e => e.limitations), ...unaddressed.map(id => `unaddressed_evidence:${id}`)]);
    row.requiresHumanReview ||= used.some(e => e.requiresHumanReview) || unaddressed.length > 0;
  }
  for (const o of out.overviews) {
    check(o.summary);
    o.limitations = distinct([...o.limitations, ...input.limitations]);
    o.requiresHumanReview ||= out.assessments.some(r => r.studentId === o.studentId && r.requiresHumanReview);
  }
}
/** For already-authorized memory input: whole-run A evidence plus the parts of the messages it cites. No internal paid retry. */
export async function assessStudents(deps: EvidenceModelDeps, value: unknown, assertCurrent: () => Promise<void>): Promise<AssessmentResult> {
  if (typeof deps.apiKey !== "string" || !deps.apiKey.trim() || deps.modelId !== modelProfile.model) throw new EvidenceError("CONFIG_INVALID");
  const input = assessmentInputSchema.parse(value), correction = input.correction;
  await traceEvidence(input);
  const messages = modelMessages(input);
  try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); }
  const { generationId, content } = await requestStage(deps, messages, correction ? "teamplanet_correction_v1" : "teamplanet_assessment_v1",
    correction ? correctionOutputJsonSchema : assessmentOutputJsonSchema);
  let assessment: AssessmentOutput, resolvedIssueIds: string[] = [];
  try {
    const raw = JSON.parse(content);
    if (correction) ({ assessment, resolvedIssueIds } = validateCorrectionOutput(raw, input, { version: input.version, runId: input.runId, iteration: 0,
      decision: "request_correction", issues: correction.issues, limitations: [], requiresHumanReview: true }));
    else assessment = validateAssessmentOutput(raw, input);
  } catch { throw new EvidenceError("MODEL_INVALID"); }
  annotate(assessment, input);
  const receipt = await verifyEvidenceGeneration(deps, generationId, deps.modelId);
  try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); }
  return { runId: input.runId, iteration: correction ? 1 : 0, assessment, resolvedIssueIds, receipt };
}
