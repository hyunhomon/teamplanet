import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { analysisArtifactsSchema, analysisSnapshotSchema, assessmentInputSchema, assessmentStageDataSchema, chunkPlanSchema,
  evidenceStageDataSchema, manifestHeaderSchema, pipelineMetadataSchema, reviewInputSchema, reviewStageDataSchema,
  stageReceiptSchema, jobKey, assertAnalysisTransition, type AnalysisArtifacts, type AnalysisSnapshot, type Part, type QueueJob, type StageName } from "@teamplanet/contracts";
import { runValidityGuard, invalidateTeam, SourceUnavailable, type ImageDeps } from "@teamplanet/collection";
import { modelProfile, type ModelRole } from "@teamplanet/ai-core";
import { JobError, LeaseLost, type JobContext, type JobErrorCode } from "@teamplanet/queue";
import { analysisId } from "./planner";
import { EvidenceError, extractEvidence, mergeEvidenceChunks, verifyEvidenceGeneration, type EvidenceChunkResult,
  type EvidenceModelDeps, type EvidenceReceipt } from "./evidence";
import { assessStudents } from "./assessor";
import { reconcileReview, reviewAssessment } from "./reviewer";
import { loadSpec, outboxInsert, prepareRun, runSources, withChunkInput, withSourceParts, type Spec } from "./runs";

export type PipelineDeps = ImageDeps & {
  apiKey?: string; models?: Record<ModelRole, string>; fetcher?: EvidenceModelDeps["fetcher"];
};
type StageJob = Extract<QueueJob, { kind: "analysis.stage" }> & { stage: StageName };
type CallRow = { attempt: number; status: string; generation_id: string | null; output_json: string | null };
type EvidenceData = ReturnType<typeof evidenceStageDataSchema.parse>;
type AssessmentData = ReturnType<typeof assessmentStageDataSchema.parse>;
type ReviewData = ReturnType<typeof reviewStageDataSchema.parse>;
type StageData = EvidenceData | AssessmentData | ReviewData;
type StageResult = StageData & { receipt: EvidenceReceipt };
const roles: Record<StageName, ModelRole> = { evidence_extraction: "evidence", assessment: "assessor", review: "reviewer" };
const failureStatuses = new Set(["blocked_provider_billing", "failed_provider_auth", "rate_limited", "failed_model"]);
const iterationOf = (job: StageJob) => job.stage === "evidence_extraction" ? 0 : job.chunkId === "run_1" ? 1 : 0;
const identity = (job: StageJob) => [job.runId, job.stage, job.chunkId, iterationOf(job)] as const;
const metadata = (error: unknown = null) => JSON.stringify(pipelineMetadataSchema.parse({ version: "pipeline-v1", error }));
const boundedJson = (value: unknown) => {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > 1048576) throw new EvidenceError("CONTEXT_LIMIT");
  return json;
};
function parseData(stage: StageName, raw: unknown): StageData {
  return stage === "evidence_extraction" ? evidenceStageDataSchema.parse(raw)
    : stage === "assessment" ? assessmentStageDataSchema.parse(raw) : reviewStageDataSchema.parse(raw);
}
function parseResult(stage: StageName, json: string): StageResult {
  const { receipt, ...data } = JSON.parse(json);
  return { ...parseData(stage, data), receipt: stageReceiptSchema.parse(receipt) };
}
function stageGuard(db: D1Database, job: StageJob) {
  return db.prepare("SELECT json(CASE WHEN EXISTS (SELECT 1 FROM analysis_runs WHERE id = ? AND status = ?) THEN '1' ELSE 'stage_changed' END)")
    .bind(job.runId, job.stage);
}
function resultRow(db: D1Database, runId: string, stage: StageName, chunkId: string, iteration: number) {
  return db.prepare("SELECT output_json FROM analysis_stage_results WHERE run_id = ? AND stage = ? AND chunk_id = ? AND iteration = ?")
    .bind(runId, stage, chunkId, iteration).first<{ output_json: string }>();
}
async function requiredResult(db: D1Database, runId: string, stage: StageName, iteration: number): Promise<AssessmentData | ReviewData> {
  const row = await resultRow(db, runId, stage, `run_${iteration}`, iteration);
  if (!row) throw new JobError("STAGE_INVALID", false);
  return parseResult(stage, row.output_json) as AssessmentData | ReviewData;
}
async function evidenceFor(deps: ImageDeps, spec: Spec) {
  const rows = await deps.db.prepare("SELECT plan_json FROM analysis_chunks WHERE run_id = ? ORDER BY ordinal").bind(spec.run_id).all<{ plan_json: string }>();
  const plans = rows.results.map(row => chunkPlanSchema.parse(JSON.parse(row.plan_json)));
  const manifest = manifestHeaderSchema.parse(JSON.parse(spec.manifest_json!));
  if (!plans.length || plans.length !== manifest.chunkCount) throw new JobError("STAGE_INVALID", false);
  const results: EvidenceChunkResult[] = [];
  let bytes = 0;
  for (const plan of plans) {
    const row = await resultRow(deps.db, spec.run_id, "evidence_extraction", plan.id, 0);
    if (!row) throw new JobError("STAGE_INVALID", false);
    bytes += new TextEncoder().encode(row.output_json).length;
    // Whole-run B/C have an explicit context bound; never drop chunks to claim success.
    if (bytes > 1048576) throw new EvidenceError("CONTEXT_LIMIT");
    results.push(parseResult("evidence_extraction", row.output_json) as EvidenceChunkResult);
  }
  return mergeEvidenceChunks(spec.run_id, plans, results);
}
async function runParts(deps: ImageDeps, spec: Spec) {
  const parts: Part[] = []; let bytes = 0;
  for await (const source of runSources(deps.db, spec.run_id)) {
    const parsed: Part[] = JSON.parse(source.parts_json);
    bytes += parsed.reduce((sum, part) => sum + part.utf8Bytes, 0);
    if (bytes > 150000) throw new EvidenceError("CONTEXT_LIMIT");
    parts.push(...parsed);
  }
  if (!parts.length) throw new JobError("STAGE_INVALID", false);
  return parts;
}
async function withRunInput<T>(deps: ImageDeps, spec: Spec, use: (input: ReturnType<typeof assessmentInputSchema.parse>, current: () => Promise<void>) => Promise<T>) {
  const config = analysisSnapshotSchema.parse(JSON.parse(spec.snapshot_json)), evidence = await evidenceFor(deps, spec);
  return withSourceParts(deps, spec, await runParts(deps, spec), async (parts, current) => {
    const input = assessmentInputSchema.parse({ version: "analysis-stages-v1", runId: spec.run_id, selection: config.rubric,
      students: JSON.parse(spec.students_json), parts, limitations: [...manifestHeaderSchema.parse(JSON.parse(spec.manifest_json!)).limitations, ...evidence.limitations],
      period: { from: spec.from_ts, to: spec.to_ts, timezone: spec.timezone }, evidence: evidence.events, correction: null });
    try { await current(); return await use(input, current); }
    finally { for (const part of input.parts) { part.text = ""; for (const image of part.images) image.dataUrl = ""; } }
  }, { metadataImages: true });
}
async function withHeartbeat<T>(context: JobContext, use: (context: JobContext) => Promise<T>) {
  let lost: unknown = null, pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(() => context.heartbeat()).catch(error => { lost = error; });
  }, 20000);
  const heartbeat = async () => { if (lost) throw lost; await context.heartbeat(); };
  try { const value = await use({ ...context, heartbeat }); await pending; if (lost) throw lost; return value; }
  finally { clearInterval(timer); await pending; }
}

async function recordFailure(deps: PipelineDeps, job: StageJob, context: JobContext, error: unknown): Promise<never> {
  if (error instanceof LeaseLost) throw error;
  let code: JobErrorCode = "UPSTREAM_UNAVAILABLE", retryable = true, delay: number | undefined;
  let billing: { providerStatus: 402; kind: "insufficient_credits" | "key_limit_exhausted" | "in_flight_budget" | "unspecified_provider_billing" } | undefined;
  const unknown = error instanceof EvidenceError && error.outcomeUnknown;
  if (error instanceof EvidenceError) {
    code = unknown ? "PROVIDER_OUTCOME_UNKNOWN" : error.code;
    retryable = !unknown && error.retryable; delay = error.retryAfterSeconds;
    if (error.billing) billing = { providerStatus: 402, kind: error.billing.kind };
  } else if (error instanceof JobError) { code = error.code; retryable = error.retryable; delay = error.retryAfterSeconds; }
  else if (error instanceof SourceUnavailable) {
    code = error.code === "SLACK_UNAVAILABLE" ? "SOURCE_UNAVAILABLE" : "DATA_INVALIDATED";
    retryable = error.retryable;
  }
  const queue = await deps.db.prepare("SELECT generation, attempts FROM queue_jobs WHERE job_key = ?").bind(jobKey(job)).first<{ generation: number; attempts: number }>();
  if (!queue) throw new LeaseLost();
  const status = code === "DATA_INVALIDATED" ? "failed_data" : code === "PROVIDER_BILLING_BLOCKED" ? "blocked_provider_billing"
    : ["PROVIDER_AUTH", "CONFIG_INVALID"].includes(code) ? "failed_provider_auth" : code === "RATE_LIMITED" ? "rate_limited" : "failed_model";
  const dataError = code === "DATA_INVALIDATED";
  const failure = { stage: job.stage, chunkId: job.chunkId, code: code === "HANDLER_FAILURE" || code === "DATA_INVALID" || code === "REFERENCE_NOT_FOUND" ? "JOB_FAILED" : code,
    retryable, ...(delay !== undefined ? { retryAfterSeconds: delay } : {}), ...(billing ? { billing } : {}) };
  await context.heartbeat();
  await context.commit(`failure${queue.generation}_${queue.attempts}`, code, [
    ...(dataError ? [] : [runValidityGuard(deps.db, job.runId, deps.now())]), stageGuard(deps.db, job),
    deps.db.prepare("UPDATE analysis_calls SET status = ?, error_code = ?, updated_at = ? WHERE run_id = ? AND stage = ? AND chunk_id = ? AND iteration = ? AND status = 'started'")
      .bind(unknown || code === "PROVIDER_OUTCOME_UNKNOWN" ? "uncertain" : "failed", code, deps.now(), ...identity(job)),
    deps.db.prepare("UPDATE analysis_runs SET status = ?, stage_metadata_json = ? WHERE id = ?").bind(status, metadata(failure), job.runId),
  ]);
  throw new JobError(code, retryable, delay);
}

async function activate(deps: PipelineDeps, job: StageJob, spec: Spec, context: JobContext) {
  if (spec.status === job.stage) return;
  const prior = pipelineMetadataSchema.safeParse(spec.status ? JSON.parse((await deps.db.prepare("SELECT stage_metadata_json FROM analysis_runs WHERE id = ?").bind(job.runId).first<{ stage_metadata_json: string | null }>())?.stage_metadata_json ?? "null") : null);
  if (!failureStatuses.has(spec.status) || !prior.success || prior.data.error?.stage !== job.stage || prior.data.error.chunkId !== job.chunkId) throw new JobError("STAGE_INVALID", false);
  const queue = await deps.db.prepare("SELECT generation, attempts FROM queue_jobs WHERE job_key = ?").bind(jobKey(job)).first<{ generation: number; attempts: number }>();
  if (!queue) throw new LeaseLost();
  await context.commit(`active${queue.generation}_${queue.attempts}`, job.runId, [runValidityGuard(deps.db, job.runId, deps.now()),
    deps.db.prepare("UPDATE analysis_runs SET status = ?, stage_metadata_json = ? WHERE id = ? AND status = ?")
      .bind(job.stage, metadata(), job.runId, spec.status)]);
}
function stageJob(runId: string, stage: StageName, iteration: 0 | 1): StageJob {
  return { kind: "analysis.stage", runId, stage, chunkId: `run_${iteration}` };
}
async function finishStage(deps: PipelineDeps, job: StageJob, spec: Spec, result: StageResult, context: JobContext, current: () => Promise<void>, artifacts?: AnalysisArtifacts) {
  await context.heartbeat(); await current();
  const db = deps.db, at = deps.now(), iteration = iterationOf(job);
  const writes: D1PreparedStatement[] = [runValidityGuard(db, job.runId, at), stageGuard(db, job),
    db.prepare("INSERT INTO analysis_stage_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(...identity(job), boundedJson(result), result.receipt.model, result.receipt.provider, result.receipt.promptVersion, at),
    db.prepare("UPDATE analysis_calls SET status = 'verified', output_json = NULL, error_code = NULL, updated_at = ? WHERE run_id = ? AND stage = ? AND chunk_id = ? AND iteration = ?")
      .bind(at, ...identity(job))];
  if (job.stage === "evidence_extraction") {
    const manifest = manifestHeaderSchema.parse(JSON.parse(spec.manifest_json!));
    const next = await db.prepare("SELECT id FROM analysis_chunks WHERE run_id = ? AND ordinal = (SELECT ordinal + 1 FROM analysis_chunks WHERE run_id = ? AND id = ?)")
      .bind(job.runId, job.runId, job.chunkId).first<{ id: string }>();
    if (next) writes.push(outboxInsert(db, { kind: "analysis.stage", runId: job.runId, stage: "evidence_extraction", chunkId: next.id }, at));
    const complete = "(SELECT COUNT(*) FROM analysis_stage_results WHERE run_id = ? AND stage = 'evidence_extraction') = ?";
    writes.push(db.prepare(`UPDATE analysis_runs SET status = 'assessment', stage_metadata_json = ? WHERE id = ? AND ${complete}`)
      .bind(metadata(), job.runId, job.runId, manifest.chunkCount));
    const nextJob = stageJob(job.runId, "assessment", 0);
    writes.push(db.prepare(`INSERT INTO queue_jobs (job_key,job_json,created_at,updated_at) SELECT ?,?,?,? WHERE ${complete} ON CONFLICT(job_key) DO NOTHING`)
      .bind(jobKey(nextJob), JSON.stringify(nextJob), at, at, job.runId, manifest.chunkCount));
  } else if (job.stage === "assessment") {
    assertAnalysisTransition("assessment", "review", { valid: true, completed: true });
    writes.push(db.prepare("UPDATE analysis_runs SET status = 'review', stage_metadata_json = ? WHERE id = ?").bind(metadata(), job.runId),
      outboxInsert(db, stageJob(job.runId, "review", iteration), at));
  } else if ((result as ReviewData).review.decision === "request_correction") {
    assertAnalysisTransition("review", "assessment", { valid: true, completed: true, correctionIteration: iteration + 1 });
    writes.push(db.prepare("UPDATE analysis_runs SET status = 'assessment', stage_metadata_json = ? WHERE id = ?").bind(metadata(), job.runId),
      outboxInsert(db, stageJob(job.runId, "assessment", 1), at));
  } else {
    if (!artifacts) throw new JobError("STAGE_INVALID", false);
    assertAnalysisTransition("review", "awaiting_professor", { valid: true, completed: true });
    const rows = await Promise.all(artifacts.candidate.assessments.map(async row => ({ ...row, id: await analysisId("assessment", `${job.runId}:${row.studentId}:${row.key}`) })));
    writes.push(db.prepare("INSERT INTO analysis_outputs VALUES (?, ?, ?)").bind(job.runId, boundedJson(artifacts), at),
      db.prepare(`INSERT INTO evidence_events (id,run_id,message_ids_json,actor_ids_json,summary,tags_json)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.messageIds'),json_extract(value,'$.actorIds'),json_extract(value,'$.summary'),json_extract(value,'$.behaviorTags') FROM json_each(?)`)
        .bind(job.runId, boundedJson(artifacts.evidence)),
      db.prepare(`INSERT INTO assessments (id,run_id,student_id,competency_key,judgement,narrative,evidence_ids_json,counter_evidence_ids_json,limitations_json,requires_human_review,confidence)
        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.studentId'),json_extract(value,'$.key'),json_extract(value,'$.judgement'),json_extract(value,'$.narrative'),
          json_extract(value,'$.evidenceIds'),json_extract(value,'$.counterEvidenceIds'),json_extract(value,'$.limitations'),json_extract(value,'$.requiresHumanReview'),json_extract(value,'$.confidence') FROM json_each(?)`)
        .bind(job.runId, boundedJson(rows)),
      db.prepare("UPDATE analysis_runs SET status = 'awaiting_professor', stage_metadata_json = ? WHERE id = ?").bind(metadata(), job.runId));
  }
  await context.commit("stored", result.receipt.generationId, writes);
}

/** References only in Queue; validated normalized output and dispatch fence share the active lease transaction. */
export async function processAnalysisStage(deps: PipelineDeps, value: Extract<QueueJob, { kind: "analysis.stage" }>, originalContext: JobContext) {
  if (value.stage === "collecting") throw new JobError("STAGE_INVALID", false);
  const job = value as StageJob;
  return withHeartbeat(originalContext, async context => {
    if (await context.checkpoint("stored")) return;
    const spec = await loadSpec(deps.db, job.runId);
    if (!spec?.manifest_json || ["cancelled", "failed_data"].includes(spec.status)) throw new JobError("DATA_INVALIDATED", false);
    await activate(deps, job, spec, context);
    try {
      const config: AnalysisSnapshot = analysisSnapshotSchema.parse(JSON.parse(spec.snapshot_json));
      const modelId = deps.models?.[roles[job.stage]];
      if (!deps.apiKey?.trim() || modelId !== config.configuredModel || config.configuredProvider !== modelProfile.provider) throw new EvidenceError("CONFIG_INVALID");
      if (job.stage !== "evidence_extraction" && !["run_0", "run_1"].includes(job.chunkId)) throw new JobError("STAGE_INVALID", false);
      let call = await deps.db.prepare("SELECT * FROM analysis_calls WHERE run_id = ? AND stage = ? AND chunk_id = ? AND iteration = ?").bind(...identity(job)).first<CallRow>();
      if (call?.status === "started" || call?.status === "uncertain") throw new JobError("PROVIDER_OUTCOME_UNKNOWN", false);
      let attempt = call?.attempt ?? 0;
      const model: EvidenceModelDeps = { apiKey: deps.apiKey!, modelId, fetcher: deps.fetcher,
        beforeRequest: async () => {
          await context.heartbeat(); attempt++;
          const wrote = await context.commit(`send${attempt}`, `attempt:${attempt}`, [runValidityGuard(deps.db, job.runId, deps.now()), stageGuard(deps.db, job),
            deps.db.prepare(`SELECT json(CASE WHEN NOT EXISTS (SELECT 1 FROM analysis_calls WHERE run_id=? AND stage=? AND chunk_id=? AND iteration=? AND status<>'failed') THEN '1' ELSE 'dispatch_already_started' END)`).bind(...identity(job)),
            deps.db.prepare(`INSERT INTO analysis_calls (run_id,stage,chunk_id,iteration,attempt,status,updated_at) VALUES (?,?,?,?,?,'started',?)
              ON CONFLICT(run_id,stage,chunk_id,iteration) DO UPDATE SET attempt=excluded.attempt,status='started',generation_id=NULL,output_json=NULL,error_code=NULL,updated_at=excluded.updated_at WHERE analysis_calls.status='failed'`)
              .bind(...identity(job), attempt, deps.now())]);
          if (!wrote) throw new JobError("PROVIDER_OUTCOME_UNKNOWN", false);
        },
        onValidated: async (output, generationId) => {
          const parsed = parseData(job.stage, output);
          if (parsed.runId !== job.runId) throw new JobError("STAGE_INVALID", false);
          await context.heartbeat();
          await context.commit(`response${attempt}`, generationId, [runValidityGuard(deps.db, job.runId, deps.now()), stageGuard(deps.db, job),
            deps.db.prepare("SELECT json(CASE WHEN EXISTS (SELECT 1 FROM analysis_calls WHERE run_id=? AND stage=? AND chunk_id=? AND iteration=? AND status='started' AND attempt=?) THEN '1' ELSE 'call_changed' END)").bind(...identity(job), attempt),
            deps.db.prepare("UPDATE analysis_calls SET status='response',generation_id=?,output_json=?,updated_at=? WHERE run_id=? AND stage=? AND chunk_id=? AND iteration=? AND status='started' AND attempt=?")
              .bind(generationId, boundedJson(parsed), deps.now(), ...identity(job), attempt)]);
        } };
      const reuse = async (current: () => Promise<void>): Promise<StageResult | null> => {
        if (call?.status !== "response" || !call.output_json || !call.generation_id) return null;
        await context.heartbeat(); await current();
        const data = parseData(job.stage, JSON.parse(call.output_json));
        const receipt = await verifyEvidenceGeneration(model, call.generation_id, modelId);
        await current(); return { ...data, receipt };
      };
      if (job.stage === "evidence_extraction") {
        await withChunkInput(deps, job.runId, job.chunkId, async (input, current) => {
          const result = await reuse(current) ?? await extractEvidence(model, input, current);
          await finishStage(deps, job, spec, result, context, current);
        });
      } else await withRunInput(deps, spec, async (input, sourceCurrent) => {
        const current = async () => { await context.heartbeat(); await sourceCurrent(); };
        const iteration = iterationOf(job);
        const first = iteration ? await requiredResult(deps.db, job.runId, "review", 0) as ReviewData : null;
        if (first && first.review.decision !== "request_correction") throw new JobError("STAGE_INVALID", false);
        if (first) input.correction = { iteration: 1, issues: first.review.issues };
        if (job.stage === "assessment") {
          const result = await reuse(current) ?? await assessStudents(model, input, current, first?.review ?? null);
          await finishStage(deps, job, spec, result, context, current);
        } else {
          const assessed = await requiredResult(deps.db, job.runId, "assessment", iteration) as AssessmentData;
          const reviewInput = reviewInputSchema.parse({ ...input, assessment: assessed.assessment, iteration });
          try {
            const result = (await reuse(current) ?? await reviewAssessment(model, reviewInput, current)) as ReviewData & { receipt: EvidenceReceipt };
            let artifacts: AnalysisArtifacts | undefined;
            if (result.review.decision !== "request_correction") {
              const initial = iteration ? await requiredResult(deps.db, job.runId, "assessment", 0) as AssessmentData : assessed;
              const initialInput = { ...reviewInput, iteration: 0, correction: null, assessment: initial.assessment };
              const correction = iteration ? { version: "analysis-stages-v1", iteration: 1, resolvedIssueIds: assessed.resolvedIssueIds, assessment: assessed.assessment } : undefined;
              const history = iteration ? await reconcileReview(initialInput, first!.review, correction, result.review) : await reconcileReview(initialInput, result.review);
              if (!history.candidate || !history.finalReview) throw new JobError("STAGE_INVALID", false);
              const saved = await deps.db.prepare("SELECT stage,output_json FROM analysis_stage_results WHERE run_id = ? ORDER BY stage,chunk_id,iteration").bind(job.runId).all<{ stage: StageName; output_json: string }>();
              artifacts = analysisArtifactsSchema.parse({ version: "analysis-output-v1", runId: job.runId, snapshot: config,
                manifest: JSON.parse(spec.manifest_json!), evidence: input.evidence, originalAssessment: history.originalAssessment, firstReview: history.firstReview,
                correction: history.correction, finalReview: history.finalReview, candidate: history.candidate, requiresHumanReview: history.requiresHumanReview,
                receipts: [...saved.results.map(row => parseResult(row.stage, row.output_json).receipt), result.receipt] });
            }
            await finishStage(deps, job, spec, result, context, current, artifacts);
          } finally { for (const part of reviewInput.parts) { part.text = ""; for (const image of part.images) image.dataUrl = ""; } }
        }
      });
    } catch (error) { return recordFailure(deps, job, context, error); }
  });
}

/** The result is exposed only after current Slack revalidation; an outage is never reported as a deletion. */
export async function withVerifiedArtifacts<T>(deps: ImageDeps, runId: string,
  use: (output: AnalysisArtifacts, input: ReturnType<typeof assessmentInputSchema.parse>, spec: Spec, current: () => Promise<void>) => Promise<T>): Promise<T> {
  const spec = await loadSpec(deps.db, runId);
  if (!spec || !["awaiting_professor", "finalized"].includes(spec.status)) throw new JobError("STAGE_INVALID", false);
  const row = await deps.db.prepare("SELECT output_json FROM analysis_outputs WHERE run_id = ?").bind(runId).first<{ output_json: string }>();
  if (!row) throw new JobError("STAGE_INVALID", false);
  return withRunInput(deps, spec, async (input, current) => {
    let output: AnalysisArtifacts;
    try {
    output = analysisArtifactsSchema.parse(JSON.parse(row.output_json));
    const history = output.correction
      ? await reconcileReview({ ...input, assessment: output.originalAssessment, iteration: 0 }, output.firstReview, output.correction, output.finalReview)
      : await reconcileReview({ ...input, assessment: output.originalAssessment, iteration: 0 }, output.firstReview);
    if (output.runId !== runId || JSON.stringify(output.snapshot) !== JSON.stringify(analysisSnapshotSchema.parse(JSON.parse(spec.snapshot_json)))
      || JSON.stringify(output.manifest) !== JSON.stringify(manifestHeaderSchema.parse(JSON.parse(spec.manifest_json!)))
      || JSON.stringify(output.evidence) !== JSON.stringify(input.evidence) || JSON.stringify(output.candidate) !== JSON.stringify(history.candidate)
      || JSON.stringify(output.finalReview) !== JSON.stringify(history.finalReview) || output.requiresHumanReview !== history.requiresHumanReview) {
      throw new Error("SUMMARY_MISMATCH");
    }
    } catch { await invalidateTeam(deps.db, spec.team_id, "summary_mismatch", deps.now()).run(); throw new JobError("DATA_INVALIDATED", false); }
    await current(); return use(output, input, spec, current);
  });
}
export const readRunArtifacts = (deps: ImageDeps, runId: string) => withVerifiedArtifacts(deps, runId, async output => output);

export const prepareAnalysis = (deps: ImageDeps, runId: string, context: JobContext) => withHeartbeat(context, current => prepareRun(deps, runId, current));
