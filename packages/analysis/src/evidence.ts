import { analysisSnapshotSchema, evidenceInputSchema, evidenceOutputJsonSchema, normalizedEvidenceSchema, validateEvidenceOutput,
  type AnalysisSnapshot, type ChunkPlan, type EvidenceInput, type NormalizedEvidence } from "@teamplanet/contracts";
import { imageFormat, IMAGE_LIMITS, sha256Hex, type ImageDeps } from "@teamplanet/collection";
import { modelProfile, requestOpenRouter, type BillingBlock } from "@teamplanet/ai-core";
import { analysisId } from "./planner";
import { loadSpec, withChunkInput } from "./runs";
import { evidencePromptVersion, evidenceSystemPrompt } from "./evidence-prompt";
export { evidencePromptVersion, evidenceSystemPrompt } from "./evidence-prompt";
export class EvidenceError extends Error {
  constructor(readonly code: "CONFIG_INVALID" | "CONTEXT_LIMIT" | "MODEL_INVALID" | "PROVIDER_AUTH" | "PROVIDER_POLICY" | "PROVIDER_RECEIPT_UNAVAILABLE" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "PROVIDER_BILLING_BLOCKED" | "DATA_INVALIDATED",
    readonly retryable = false, readonly billing?: BillingBlock, readonly generationId?: string, readonly retryAfterSeconds?: number,
    readonly outcomeUnknown = false) { super(code); }
}
export type EvidenceReceipt = { generationId: string; model: string; provider: "DeepInfra"; requestedProvider: "deepinfra/bf16"; promptVersion: typeof evidencePromptVersion };
export type EvidenceChunkResult = { runId: string; chunkId: string; processedPartIds: string[]; events: NormalizedEvidence[]; limitations: string[];
  missingImageIds: string[]; receipt: EvidenceReceipt };
export type EvidenceModelDeps = {
  apiKey: string; modelId: string; fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  beforeRequest?: () => Promise<void>;
  onValidated?: (output: unknown, generationId: string) => Promise<void>;
};
const distinct = (values: string[]) => [...new Set(values)].sort();
const inference = /성격|내향적|외향적|게으|무능|속마음|의도(?:가|는|를)|동기(?:가|는|를)|성별|인종|종교|장애인|우울증|성적|낙제|발언량|메시지\s*(?:수|개수)|발언\s*횟수|\b(?:lazy|introvert|extrovert|personality|grade|motivation|IQ)\b/i;
/** `support` adds already verified text (B: A summaries) to the action-word check only, never to the source-copy check. */
export function checkSummary(summary: string, input: { parts: readonly { text: string }[] }, support: readonly string[] = []) {
  if (inference.test(summary)) throw new EvidenceError("MODEL_INVALID");
  // An external action cannot be manufactured from an unrelated, correctly quoted statement.
  const source = [...input.parts.map(p => p.text), ...support].join("\n");
  for (const action of ["배포", "구현", "수정", "완성", "테스트", "합의", "커밋", "코드", "디자인", "설계", "회의", "제출", "승인"]) {
    const supported = action === "수정" ? /수정|추가|고쳤|반영/.test(source) : source.includes(action);
    if (summary.includes(action) && !supported) throw new EvidenceError("MODEL_INVALID");
  }
  checkSourceCopy(summary, input);
}
/** Applies to every generated field that may be persisted, including limitations. */
export function checkSourceCopy(text: string, input: { parts: readonly { text: string }[] }) {
  for (const p of input.parts) {
    if (p.text.length >= 12 && text.includes(p.text)) throw new EvidenceError("MODEL_INVALID");
    for (let i = 0; i + 32 <= text.length; i++) if (p.text.includes(text.slice(i, i + 32))) throw new EvidenceError("MODEL_INVALID");
  }
}
function modelMessages(input: EvidenceInput) {
  const images = input.parts.flatMap(p => p.images.map(image => ({ ...image, partId: p.id })));
  if (images.length > 1) throw new EvidenceError("CONTEXT_LIMIT");
  for (const image of images) {
    const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+=*)$/.exec(image.dataUrl);
    if (!match || match[1]!.length > Math.ceil(IMAGE_LIMITS.bytes / 3) * 4) throw new EvidenceError("CONTEXT_LIMIT");
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(match[1]!), c => c.charCodeAt(0)); } catch { throw new EvidenceError("MODEL_INVALID"); }
    const format = imageFormat(bytes); bytes.fill(0);
    if (!format || format.mime !== image.dataUrl.slice(5, image.dataUrl.indexOf(";"))) throw new EvidenceError("MODEL_INVALID");
    // Technical vision context bound, not an app spending quota. Never resize/sample silently.
    if (format.width * format.height > 1048576) throw new EvidenceError("CONTEXT_LIMIT");
  }
  const data = JSON.stringify({ ...input, parts: input.parts.map(p => ({ ...p, images: p.images.map(({ dataUrl, ...metadata }) => metadata) })) });
  if (new TextEncoder().encode(data).length > 150000) throw new EvidenceError("CONTEXT_LIMIT");
  return [{ role: "system", content: evidenceSystemPrompt }, { role: "user", content: [
    { type: "text", text: data }, ...images.flatMap(image => [{ type: "text", text: JSON.stringify({ imageId: image.id, partId: image.partId }) },
      { type: "image_url", image_url: { url: image.dataUrl } }]),
  ] }];
}
/** Metadata only. Never call the separate stored-prompt/completion endpoint. */
export async function verifyEvidenceGeneration(deps: EvidenceModelDeps, generationId: string, expectedModel: string): Promise<EvidenceReceipt> {
  if (!/^gen-[A-Za-z0-9_-]{1,150}$/.test(generationId)) throw new EvidenceError("MODEL_INVALID");
  let response: Response;
  const send = deps.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
  try { response = await send(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
    method: "GET", headers: { Authorization: `Bearer ${deps.apiKey}` }, redirect: "manual", signal: AbortSignal.timeout(15000) }); }
  catch { throw new EvidenceError("PROVIDER_RECEIPT_UNAVAILABLE", true, undefined, generationId); }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new EvidenceError("PROVIDER_POLICY", false, undefined, generationId); }
  const body: any = response.ok ? await response.json().catch(() => null) : null;
  if (!body?.data || body.data.id !== generationId || body.data.model !== expectedModel || body.data.provider_name !== "DeepInfra") {
    if (body?.data) throw new EvidenceError("PROVIDER_POLICY", false, undefined, generationId);
    throw new EvidenceError("PROVIDER_RECEIPT_UNAVAILABLE", true, undefined, generationId);
  }
  return { generationId, model: expectedModel, provider: "DeepInfra", requestedProvider: modelProfile.provider, promptVersion: evidencePromptVersion };
}
/** One pinned structured call shared by the A and B roles; returns unparsed content. No internal paid retry. */
export async function requestStage(deps: EvidenceModelDeps, messages: Array<Record<string, unknown>>, name: string, schema: Record<string, unknown>) {
  await deps.beforeRequest?.();
  let response;
  let retryAfter: number | undefined;
  try {
    const send = deps.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
    response = await requestOpenRouter(deps.apiKey, deps.modelId, messages, async (url, init) => {
      const res = await send(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(120000) });
      if (res.status >= 300 && res.status < 400) { await res.body?.cancel(); throw new EvidenceError("PROVIDER_POLICY"); }
      const delay = res.headers.get("Retry-After"); if (delay && /^\d+$/.test(delay) && Number.isSafeInteger(Number(delay))) retryAfter = Number(delay);
      return res;
    }, { responseFormat: { type: "json_schema", json_schema: { name, strict: true, schema } } });
  } catch (error) {
    if (error instanceof EvidenceError) throw error;
    throw new EvidenceError("UPSTREAM_UNAVAILABLE", true, undefined, undefined, undefined, true);
  }
  if (!response.ok) {
    if (response.error.code === "OPENROUTER_INVALID_RESPONSE") throw new EvidenceError("MODEL_INVALID");
    if ("kind" in response.error) throw new EvidenceError("PROVIDER_BILLING_BLOCKED", response.error.retryable, response.error, undefined, response.error.retryAfterSeconds);
    const status = response.error.providerStatus;
    throw new EvidenceError(status === 401 ? "PROVIDER_AUTH" : status === 403 ? "PROVIDER_POLICY" : status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE", status === 429 || status >= 500 || status === 200, undefined, undefined, retryAfter);
  }
  const data = response.data as any, choice = data?.choices?.[0];
  if (data?.model !== deps.modelId || !/^gen-[A-Za-z0-9_-]{1,150}$/.test(data?.id ?? "")) throw new EvidenceError("PROVIDER_POLICY");
  if (choice?.finish_reason === "length") throw new EvidenceError("CONTEXT_LIMIT");
  if (data.choices?.length !== 1 || choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string" || choice.message.content.length > 1048576) throw new EvidenceError("MODEL_INVALID");
  return { generationId: data.id as string, content: choice.message.content as string };
}
/** For already-authorized memory input. Production orchestration should use extractRunEvidence below. No internal paid retry. */
export async function extractEvidence(deps: EvidenceModelDeps, value: unknown, assertCurrent: () => Promise<void>): Promise<EvidenceChunkResult> {
  if (typeof deps.apiKey !== "string" || !deps.apiKey.trim() || deps.modelId !== modelProfile.model) throw new EvidenceError("CONFIG_INVALID");
  const input = evidenceInputSchema.parse(value), messages = modelMessages(input);
  try {
    validateEvidenceOutput({ version: input.version, processedPartIds: input.primaryPartIds, events: [], limitations: [] }, input);
    if (input.parts.some(p => p.images.some(i => !p.imageIds.includes(i.id) || i.studentId !== null && !input.students.some(s => s.id === i.studentId)))) throw new Error();
  } catch { throw new EvidenceError("MODEL_INVALID"); }
  try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); }
  const { generationId, content } = await requestStage(deps, messages, "teamplanet_evidence_v1", evidenceOutputJsonSchema);
  let parsed;
  try { parsed = validateEvidenceOutput(JSON.parse(content), input); } catch { throw new EvidenceError("MODEL_INVALID"); }
  if (parsed.events.length > 512) throw new EvidenceError("CONTEXT_LIMIT");
  const events: NormalizedEvidence[] = [];
  for (const event of parsed.events) {
    checkSummary(event.summary, input);
    const citations = await Promise.all(event.citations.map(async c => ({ messageId: input.parts.find(p => p.id === c.partId)!.messageId, start: c.start, end: c.end, hash: await sha256Hex(c.quote) })));
    const key = JSON.stringify([distinct(event.messageIds), distinct(event.actorIds), distinct(event.behaviorTags), event.modality]);
    events.push(normalizedEvidenceSchema.parse({ id: await analysisId("evidence", `${input.runId}:${key}`), messageIds: distinct(event.messageIds), actorIds: distinct(event.actorIds), summary: event.summary,
      behaviorTags: distinct(event.behaviorTags), modality: event.modality, citations, imageIds: distinct(event.imageCitations.map(c => c.imageId)),
      limitations: distinct([...input.limitations, ...parsed.limitations, ...event.limitations, ...input.parts.filter(p => event.messageIds.includes(p.messageId)).flatMap(p => p.limitations),
        "model_interpretation_requires_independent_review", ...(event.imageCitations.length ? ["image_interpretation_requires_review"] : [])]), requiresHumanReview: true }));
  }
  const missingImageIds = distinct(input.parts.flatMap(p => p.imageIds.filter(id => !p.images.some(image => image.id === id))));
  for (const text of [...parsed.limitations, ...parsed.events.flatMap(event => event.limitations)]) checkSourceCopy(text, input);
  const output = { runId: input.runId, chunkId: input.chunkId, processedPartIds: parsed.processedPartIds, events: mergeEvents(events),
    missingImageIds, limitations: distinct([...input.limitations, ...parsed.limitations, ...input.parts.flatMap(p => p.limitations), ...(missingImageIds.length ? ["image_input_incomplete"] : [])]) };
  if (deps.onValidated) { await assertCurrent(); await deps.onValidated(output, generationId); }
  // Never infer the actual provider from requested routing. Generation metadata confirms it.
  const receipt = await verifyEvidenceGeneration(deps, generationId, deps.modelId);
  try { await assertCurrent(); } catch { throw new EvidenceError("DATA_INVALIDATED"); }
  return { ...output, receipt };
}
export function mergeEvents(values: readonly NormalizedEvidence[]): NormalizedEvidence[] {
  const merged = new Map<string, NormalizedEvidence>();
  for (const value of values) {
    const event = normalizedEvidenceSchema.parse(value), existing = merged.get(event.id);
    if (!existing) { merged.set(event.id, event); continue; }
    if (JSON.stringify([existing.messageIds, existing.actorIds, existing.behaviorTags, existing.modality]) !== JSON.stringify([event.messageIds, event.actorIds, event.behaviorTags, event.modality])) throw new Error("STAGE_REFERENCE_INVALID");
    const summaries = distinct([existing.summary, event.summary]);
    const citationMap = new Map([...existing.citations, ...event.citations].map(c => [JSON.stringify(c), c]));
    existing.citations = [...citationMap.values()].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    existing.imageIds = distinct([...existing.imageIds, ...event.imageIds]);
    existing.limitations = distinct([...existing.limitations, ...event.limitations, ...summaries.slice(1).map(s => `overlap_summary_variant: ${s}`)]);
    existing.summary = summaries[0]!; existing.requiresHumanReview ||= event.requiresHumanReview || summaries.length > 1;
  }
  return [...merged.values()].sort((a,b) => a.id.localeCompare(b.id));
}
export function mergeEvidenceChunks(runId: string, plans: readonly ChunkPlan[], results: readonly EvidenceChunkResult[]) {
  const expected = new Map(plans.map(p => [p.id, p.parts.map(p => p.id).sort().join()]));
  if (results.some(r => r.runId !== runId || !expected.has(r.chunkId) || [...r.processedPartIds].sort().join() !== expected.get(r.chunkId))
    || plans.some(p => !results.some(r => r.chunkId === p.id))) throw new Error("STAGE_COVERAGE_INVALID");
  const known = new Set(plans.flatMap(p => p.parts.map(p => p.messageId)));
  if (results.some(r => r.events.some(e => e.messageIds.some(id => !known.has(id))))) throw new Error("STAGE_REFERENCE_INVALID");
  return { events: mergeEvents(results.flatMap(r => r.events)), limitations: distinct(results.flatMap(r => r.limitations)),
    missingImageIds: distinct(results.flatMap(r => r.missingImageIds)), chunks: expected.size };
}
export async function extractRunEvidence(deps: ImageDeps, model: EvidenceModelDeps, runId: string, chunkId: string) {
  const spec = await loadSpec(deps.db, runId); if (!spec) throw new EvidenceError("DATA_INVALIDATED");
  let config: AnalysisSnapshot;
  try { config = analysisSnapshotSchema.parse(JSON.parse(spec.snapshot_json)); } catch { throw new EvidenceError("CONFIG_INVALID"); }
  if (config.configuredModel !== model.modelId || config.configuredProvider !== modelProfile.provider || config.promptVersion !== evidencePromptVersion) throw new EvidenceError("CONFIG_INVALID");
  return withChunkInput(deps, runId, chunkId, (input, current) => extractEvidence(model, input, current));
}
