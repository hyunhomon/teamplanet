import { analysisSnapshotSchema, assessmentInputSchema, assessmentOutputJsonSchema, competencyLabels, correctionOutputJsonSchema, reviewOutputSchema,
  validateAssessmentOutput, validateCorrectionOutput, type AnalysisSnapshot, type AssessmentInput, type AssessmentOutput, type NormalizedEvidence, type Part } from "@teamplanet/contracts";
import { sha256Hex, type ImageDeps } from "@teamplanet/collection";
import { modelProfile } from "@teamplanet/ai-core";
import { checkSummary, EvidenceError, requestStage, verifyEvidenceGeneration, type EvidenceModelDeps, type EvidenceReceipt } from "./evidence";
import { loadSpec, withSourceParts } from "./runs";
import { assessorPromptVersion, assessorSystemPrompt } from "./assessor-prompt";
export { assessorPromptVersion, assessorSystemPrompt } from "./assessor-prompt";
export type AssessmentResult = { runId: string; iteration: 0 | 1; assessment: AssessmentOutput; resolvedIssueIds: string[]; receipt: EvidenceReceipt };
const distinct = (values: string[]) => [...new Set(values)].filter(Boolean).sort();
// On top of the A inference check: scores, rankings and activity-volume proxies never describe a competency.
const proxy = /점수|등급|순위|학점|말수|활동량|참여도|답장\s*수|이모지\s*수|링크\s*(?:수|개수)|\b(?:score|rank(?:ing)?)\b/i;
// The messages B may read: those its evidence cites plus those a correction issue names.
const citedIds = (input: AssessmentInput) => new Set([...input.evidence.flatMap(e => e.messageIds), ...(input.correction?.issues.flatMap(i => i.messageIds) ?? [])]);
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
/** Only C's first-round correction request may start the single B correction (#16 STAGE_CORRECTION_LIMIT); checked before any paid call. */
function correctionRequest(input: AssessmentInput, review: unknown) {
  const issues = input.correction?.issues, parsed = reviewOutputSchema.safeParse(review), selected: readonly string[] = input.selection.selectedCompetencies;
  if (!issues) { if (review !== null) throw new EvidenceError("MODEL_INVALID"); return null; }
  if (!parsed.success || parsed.data.runId !== input.runId || parsed.data.iteration !== 0 || parsed.data.decision !== "request_correction"
    || JSON.stringify(parsed.data.issues) !== JSON.stringify(issues)
    || issues.some(i => !input.students.some(s => s.id === i.studentId) || !selected.includes(i.competency)
      || i.evidenceIds.some(id => !input.evidence.some(e => e.id === id)) || i.messageIds.some(id => !input.parts.some(p => p.messageId === id)))) throw new EvidenceError("MODEL_INVALID");
  return parsed.data;
}
function modelMessages(input: AssessmentInput) {
  const cited = citedIds(input);
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
  const evidence = new Map(input.evidence.map(e => [e.id, e])), cited = citedIds(input);
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
/**
 * For already-authorized memory input: whole-run A evidence plus the parts of the messages it cites. A correction needs C's
 * iteration-0 review that requested it. Production orchestration should use assessRun below. No internal paid retry.
 */
export async function assessStudents(deps: EvidenceModelDeps, value: unknown, assertCurrent: () => Promise<void>, review: unknown = null): Promise<AssessmentResult> {
  if (typeof deps.apiKey !== "string" || !deps.apiKey.trim() || deps.modelId !== modelProfile.model) throw new EvidenceError("CONFIG_INVALID");
  const input = assessmentInputSchema.parse(value), correction = input.correction, request = correctionRequest(input, review);
  await traceEvidence(input);
  const messages = modelMessages(input);
  try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); }
  const { generationId, content } = await requestStage(deps, messages, correction ? "teamplanet_correction_v1" : "teamplanet_assessment_v1",
    correction ? correctionOutputJsonSchema : assessmentOutputJsonSchema);
  let assessment: AssessmentOutput, resolvedIssueIds: string[] = [];
  try {
    const raw = JSON.parse(content);
    if (request) ({ assessment, resolvedIssueIds } = validateCorrectionOutput(raw, input, request));
    else assessment = validateAssessmentOutput(raw, input);
  } catch { throw new EvidenceError("MODEL_INVALID"); }
  annotate(assessment, input);
  const receipt = await verifyEvidenceGeneration(deps, generationId, deps.modelId);
  try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); }
  return { runId: input.runId, iteration: correction ? 1 : 0, assessment, resolvedIssueIds, receipt };
}
/** Production wrapper: restores only the cited (and correction-named) messages from current Slack under the real run fence. */
export async function assessRun(deps: ImageDeps, model: EvidenceModelDeps, runId: string, evidence: readonly NormalizedEvidence[], review: unknown = null) {
  const spec = await loadSpec(deps.db, runId);
  if (!spec?.manifest_json || spec.status === "cancelled") throw new EvidenceError("DATA_INVALIDATED");
  let config: AnalysisSnapshot;
  try { config = analysisSnapshotSchema.parse(JSON.parse(spec.snapshot_json)); } catch { throw new EvidenceError("CONFIG_INVALID"); }
  if (config.configuredModel !== model.modelId || config.configuredProvider !== modelProfile.provider || config.promptVersion !== assessorPromptVersion) throw new EvidenceError("CONFIG_INVALID");
  const parsed = review === null ? null : reviewOutputSchema.safeParse(review);
  if (parsed && !parsed.data?.issues.length) throw new EvidenceError("MODEL_INVALID");
  const issues = parsed?.data?.issues ?? null;
  const wanted: Part[] = [];
  for (const id of new Set([...evidence.flatMap(e => e.messageIds), ...(issues ?? []).flatMap(i => i.messageIds)])) {
    const row = await deps.db.prepare("SELECT parts_json FROM analysis_sources WHERE run_id = ? AND id = ?").bind(runId, id).first<{ parts_json: string }>();
    if (!row) throw new EvidenceError("DATA_INVALIDATED");
    wanted.push(...JSON.parse(row.parts_json));
  }
  return withSourceParts(deps, spec, wanted, async (parts, current) => {
    const input = assessmentInputSchema.parse({ version: "analysis-stages-v1", runId, selection: config.rubric, students: JSON.parse(spec.students_json), parts,
      limitations: JSON.parse(spec.manifest_json!).limitations, period: { from: spec.from_ts, to: spec.to_ts, timezone: spec.timezone }, evidence,
      correction: issues === null ? null : { iteration: 1, issues } });
    try { return await assessStudents(model, input, current, review); }
    finally { for (const p of input.parts) { p.text = ""; for (const image of p.images) image.dataUrl = ""; } }
  });
}
