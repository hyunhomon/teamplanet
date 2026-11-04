import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { analysisRoutes } from "../apps/api/src/analysis";
import { createHandlers } from "../apps/consumer/src/index";
import type { ProtectedEnv } from "../apps/api/src/guard";
import { analysisArtifactsSchema, analysisRunResponseSchema, jobKey, type QueueEnvelope } from "@teamplanet/contracts";
import { consumeMessage, flushOutbox, JobStore } from "@teamplanet/queue";
import { readRunArtifacts } from "@teamplanet/analysis";
import { purgeTeam, requestErasure } from "@teamplanet/collection";
import { deflateSync } from "node:zlib";
import { collectionFixture } from "./helpers/collection";
import { professors } from "@teamplanet/contracts/fixtures";

let f: Awaited<ReturnType<typeof collectionFixture>>, clock: number, app: Hono<ProtectedEnv>, store: JobStore;
let professor: (typeof professors)[number], work: QueueEnvelope[], dead: QueueEnvelope[];
let paid: string[], receipts: string[], correction: boolean, receiptOutage: number, failStage: string | null;
let status: number, limitSource: string, networkFailure: boolean, revokeAt: string | null;
let send: (url: string, init: RequestInit) => Promise<Response>;
let key: string | undefined;
let quiet: boolean;
let cancelAt: string | null, inputs: { name: string; input: any; wire: string }[];
const configured = { evidence: "qwen/qwen3.5-9b", assessor: "qwen/qwen3.5-9b", reviewer: "qwen/qwen3.5-9b" };
const roles = new Map<string, string>();
beforeEach(async () => {
  f = await collectionFixture(); clock = f.now(); professor = f.professor; work = []; dead = []; paid = []; receipts = [];
  correction = false; quiet = false; receiptOutage = 0; failStage = null; status = 503; limitSource = "openrouter_credits"; networkFailure = false; revokeAt = null; cancelAt = null; inputs = []; key = "synthetic-key"; roles.clear();
  f.sqlite.run("INSERT INTO course_rubric_settings VALUES (?, 'communication-v1', '[\"clarity\"]', 1)", [f.course.id]);
  f.sqlite.run("INSERT INTO collection_coverage (request_id,team_id,from_ms,to_ms,status,started_at,updated_at) VALUES (?,?,?,?,'complete',?,?)", [crypto.randomUUID(), f.teamId, f.start, f.start + 200000, clock, clock]);
  send = async () => Response.json({ ok: true, messages: [{ ts: f.slackTs, user: f.userId, text: f.text }], has_more: false });
  app = new Hono<ProtectedEnv>(); app.use("*", async (c, next) => { c.set("professor", professor); await next(); });
  app.route("/", analysisRoutes(() => clock, (url, init) => send(url, init)));
  store = new JobStore(f.db, () => clock);
});
afterEach(() => f.sqlite.close());
const imageDeps = () => ({ db: f.db, now: () => clock, tokenKey: f.tokenKey, send: (url: string, init: RequestInit) => send(url, init) });
const call = (path: string, body?: unknown) => app.request(`https://synthetic${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { DB: f.db, SLACK_TOKEN_KEY: f.tokenKey });
async function create() {
  const response = await call("/analysis-runs", { teamId: f.teamId, from: new Date(f.start).toISOString(), to: new Date(f.start + 200000).toISOString(), timezone: "Asia/Seoul", idempotencyKey: crypto.randomUUID() });
  expect(response.status).toBe(202); return analysisRunResponseSchema.parse(await response.json());
}
const fetcher = async (url: string, init: RequestInit) => {
  if (url.includes("/generation?")) {
    const generation = new URL(url).searchParams.get("id")!; receipts.push(generation);
    if (receiptOutage-- > 0) return Response.json({ error: "synthetic" }, { status: 503 });
    return Response.json({ data: { id: generation, model: configured.evidence, provider_name: "DeepInfra" } });
  }
  const request = JSON.parse(init.body as string), name: string = request.response_format.json_schema.name;
  paid.push(name); const generation = `gen-synthetic-${paid.length}`; roles.set(generation, name);
  if (networkFailure) throw Error("synthetic transport failure with private source text");
  if (failStage === name) return Response.json({ error: { message: "private-source-token-do-not-store", metadata: { limit_source: limitSource } } }, { status, headers: { "Retry-After": "11" } });
  const content = request.messages[1].content, input = JSON.parse(typeof content === "string" ? content : content[0].text);
  inputs.push({ name, input, wire: init.body as string });
  if (revokeAt === name) f.sqlite.run("UPDATE consents SET status='withdrawn',recorded_at=?", [clock]);
  if (cancelAt === name) await call(`/analysis-runs/${input.runId}/cancel`, {});
  let output: unknown;
  if (name === "teamplanet_evidence_v1") {
    const p = input.parts.find((p: any) => input.primaryPartIds.includes(p.id) && p.text.length) ?? input.parts[0];
    const image = input.parts.find((p: any) => p.images.length);
    const quote = p.text.slice(0, 4000);
    output = { version: input.version, processedPartIds: input.primaryPartIds, limitations: [], events: [{
      messageIds: [p.messageId], actorIds: [p.studentId], summary: "프로젝트의 설명 발화가 관찰된다.", behaviorTags: ["clarity"], modality: "text",
      citations: [{ partId: p.id, start: p.start, end: p.start + quote.length, quote }], imageCitations: [], limitations: [], requiresHumanReview: true }] };
    if (image) Object.assign((output as any).events[0], { modality: "mixed", imageCitations: [{ partId: image.id, imageId: image.images[0].id, observation: "합성 도식의 구성 요소가 보인다.", actorId: image.images[0].studentId }] });
    if (quiet) (output as any).events = [];
  } else if (name === "teamplanet_review_v1") {
    const needsCorrection = correction && input.iteration === 0;
    output = { version: input.version, runId: input.runId, iteration: input.iteration, decision: needsCorrection ? "request_correction" : "accept",
      issues: needsCorrection ? [{ id: "issue_context", code: "context_missing", studentId: input.students[0].id, competency: "clarity", evidenceIds: [input.evidence[0].id],
        messageIds: [input.parts[0].messageId], instruction: "관찰 범위의 한계를 명시하세요." }] : [], limitations: [], requiresHumanReview: false };
  } else {
    const assessment = { version: input.version, runId: input.runId,
      overviews: input.students.map((s: any) => ({ studentId: s.id, summary: "관찰된 설명 사례를 요약했다.", limitations: [], requiresHumanReview: false })),
      assessments: input.candidates.map((c: any) => c.evidenceIds.length ? ({ ...c, judgement: "observed_strength", narrative: "설명의 맥락을 구체화한 발화가 있다.", counterEvidenceIds: [], confidence: "medium",
        limitations: input.correction ? ["단일 관찰 범위"] : [], requiresHumanReview: false }) : ({ ...c, judgement: "insufficient_evidence", narrative: "관련 근거를 충분히 확인하지 못했다.", counterEvidenceIds: [], confidence: "low", limitations: ["관찰 기회 부족"], requiresHumanReview: true })) };
    output = input.correction ? { version: input.version, iteration: 1, resolvedIssueIds: input.correction.issues.map((i: any) => i.id), assessment } : assessment;
  }
  return Response.json({ id: generation, model: configured.evidence, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] });
};
const handlers = () => createHandlers(f.db, () => clock, { ...imageDeps(), apiKey: key, models: configured, fetcher });
const queue = { send: async (value: QueueEnvelope) => { work.push(value); } };
const dlq = { send: async (value: QueueEnvelope) => { dead.push(value); } };
async function deliver(envelope: QueueEnvelope) {
  await consumeMessage({ id: crypto.randomUUID(), body: envelope, attempts: 1, ack() {}, retry() { work.push(envelope); } }, store, dlq as any, handlers());
}
async function drain(until?: () => boolean) {
  for (let i = 0; i < 50; i++) {
    if (until?.()) return;
    await flushOutbox(store, queue as any, dlq as any);
    const envelope = work.shift(); if (!envelope) return;
    await deliver(envelope);
    const due = f.sqlite.query("SELECT MIN(MAX(available_at,COALESCE(lease_until,0))) AS at FROM queue_jobs WHERE status IN ('pending','retry','running')").get() as { at: number | null };
    if (due.at !== null && due.at > clock) clock = due.at + 1;
  }
  throw Error("synthetic queue did not settle");
}
const count = (table: string) => (f.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("actual prepare/outbox/Consumer A-B-C reaches a source-verified professor candidate once", async () => {
  const run = await create(); await drain();
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.status).toBe("awaiting_professor"); expect(state.valid).toBe(true); expect(state.progress.completedChunks).toBe(1);
  expect(paid).toEqual(["teamplanet_evidence_v1", "teamplanet_assessment_v1", "teamplanet_review_v1"]);
  const output = analysisArtifactsSchema.parse(await (await call(`/analysis-runs/${run.id}/artifacts`)).json());
  expect(output.candidate.assessments).toHaveLength(1); expect(output.candidate.assessments[0]!.requiresHumanReview).toBe(true);
  expect(output.receipts).toHaveLength(3); expect(output.candidate.assessments[0]!.evidenceIds).toEqual([output.evidence[0]!.id]);
  expect(count("assessments")).toBe(1); expect(count("evidence_events")).toBe(1); expect(count("analysis_outputs")).toBe(1);
  const before = paid.length;
  for (const row of f.sqlite.query("SELECT job_json,generation FROM queue_jobs").all() as any[]) await deliver({ version: 1, generation: row.generation, job: JSON.parse(row.job_json) });
  expect(paid).toHaveLength(before); expect(count("assessments")).toBe(1);
  const persisted = JSON.stringify([f.sqlite.query("SELECT * FROM analysis_calls").all(), f.sqlite.query("SELECT * FROM analysis_stage_results").all(), f.sqlite.query("SELECT * FROM analysis_outputs").all(), f.sqlite.query("SELECT * FROM queue_jobs").all()]);
  expect(persisted).not.toContain(f.text); expect(persisted).not.toContain("synthetic-key"); expect(persisted).not.toContain("data:image");
});

test("one B correction and C rereview preserve original, changed candidate and first issues", async () => {
  correction = true; const run = await create(); await drain();
  const output = await readRunArtifacts(imageDeps(), run.id);
  expect(paid).toEqual(["teamplanet_evidence_v1", "teamplanet_assessment_v1", "teamplanet_review_v1", "teamplanet_correction_v1", "teamplanet_review_v1"]);
  expect(output.correction?.iteration).toBe(1); expect(output.firstReview.issues).toHaveLength(1); expect(output.finalReview.iteration).toBe(1);
  expect(output.candidate.assessments[0]!.limitations).toContain("단일 관찰 범위"); expect(count("analysis_stage_results")).toBe(5);
});

test("all four explicitly selected competencies persist once each, with insufficient evidence retained", async () => {
  f.sqlite.run("UPDATE course_rubric_settings SET selected_competencies_json='[\"clarity\",\"information_sharing\",\"feedback_alignment\",\"decision_execution\"]'");
  const run = await create(); await drain(); const output = await readRunArtifacts(imageDeps(), run.id);
  expect(output.candidate.assessments).toHaveLength(4); expect(count("assessments")).toBe(4);
  expect(output.candidate.assessments.filter(row => row.judgement === "insufficient_evidence")).toHaveLength(3);
});

test("observed conversation without usable evidence becomes an insufficient-evidence candidate, never a negative grade", async () => {
  quiet = true; const run = await create(); await drain(); const output = await readRunArtifacts(imageDeps(), run.id);
  expect(output.evidence).toEqual([]); expect(count("evidence_events")).toBe(0);
  expect(output.candidate.assessments[0]).toMatchObject({ judgement: "insufficient_evidence", requiresHumanReview: true });
});

test("a missing provider receipt retries metadata only, never the paid completion", async () => {
  receiptOutage = 1; const run = await create(); await drain();
  expect((await readRunArtifacts(imageDeps(), run.id)).receipts).toHaveLength(3);
  expect(paid).toHaveLength(3); expect(receipts.filter(id => id === "gen-synthetic-1")).toHaveLength(2);
  expect(f.sqlite.query("SELECT status,output_json FROM analysis_calls WHERE stage='evidence_extraction'").get()).toEqual({ status: "verified", output_json: null });
});

test("billing blocks remain distinct and explicit resume reuses completed A without automatic retry", async () => {
  failStage = "teamplanet_assessment_v1"; status = 402; const run = await create(); await drain();
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.status).toBe("blocked_provider_billing"); expect(state.errors.find(e => e.code === "PROVIDER_BILLING_BLOCKED")?.billing?.kind).toBe("insufficient_credits");
  expect(paid).toHaveLength(2); expect(count("assessments")).toBe(0);
  failStage = null; expect((await call(`/analysis-runs/${run.id}/resume`, {})).status).toBe(202); await drain();
  expect((await readRunArtifacts(imageDeps(), run.id)).candidate.assessments).toHaveLength(1);
  expect(paid.filter(name => name === "teamplanet_evidence_v1")).toHaveLength(1);
});

test("rate limits preserve Retry-After, then a retry completes without repeating earlier stages", async () => {
  failStage = "teamplanet_review_v1"; status = 429; const run = await create();
  await drain(() => paid.length === 3);
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.status).toBe("rate_limited"); expect(state.errors.find(e => e.code === "RATE_LIMITED")?.retryAfterSeconds).toBe(11);
  failStage = null; await drain(); expect((await readRunArtifacts(imageDeps(), run.id)).finalReview.decision).toBe("accept");
  expect(paid.filter(name => name === "teamplanet_evidence_v1")).toHaveLength(1);
  expect(paid.filter(name => name === "teamplanet_assessment_v1")).toHaveLength(1);
});

test("an ambiguous transport outcome is fenced against automatic or API-requested paid resends", async () => {
  networkFailure = true; const run = await create(); await drain();
  expect(paid).toHaveLength(1); expect(count("analysis_stage_results")).toBe(0);
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.errors.some(e => e.code === "PROVIDER_OUTCOME_UNKNOWN")).toBe(true);
  expect((await call(`/analysis-runs/${run.id}/resume`, {})).status).toBe(409);
  expect((f.sqlite.query("SELECT status FROM analysis_calls").get() as any).status).toBe("uncertain");
});

for (const name of ["teamplanet_evidence_v1", "teamplanet_assessment_v1", "teamplanet_review_v1"]) test(`withdrawal during ${name} prevents storage and later model stages`, async () => {
  revokeAt = name; const run = await create(); await drain();
  expect(count("analysis_outputs")).toBe(0); expect(count("assessments")).toBe(0);
  expect(paid.at(-1)).toBe(name);
  expect((await call(`/analysis-runs/${run.id}/artifacts`)).status).toBe(409);
});

test("stored output is owner-only, remote revalidated, and all call/output data joins erasure", async () => {
  const run = await create(); await drain();
  professor = professors[1]!; expect((await call(`/analysis-runs/${run.id}/artifacts`)).status).toBe(404); professor = f.professor;
  send = async () => Response.json({ ok: false, error: "ratelimited" });
  expect((await call(`/analysis-runs/${run.id}/artifacts`)).status).toBe(503);
  expect(count("analysis_outputs")).toBe(1); expect((f.sqlite.query("SELECT deleted_at FROM message_refs").get() as any).deleted_at).toBeNull();
  await requestErasure(f.db, f.teamId, "request", clock); await purgeTeam(f.db, f.teamId, clock);
  for (const table of ["analysis_calls", "analysis_outputs", "analysis_stage_results", "assessments"]) expect(count(table)).toBe(0);
});

test("missing runtime credentials are a visible configuration failure, never a fabricated model success", async () => {
  key = undefined; const run = await create(); await drain();
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.status).toBe("failed_provider_auth"); expect(state.errors.some(e => e.code === "CONFIG_INVALID")).toBe(true);
  expect(paid).toHaveLength(0); expect(count("analysis_outputs")).toBe(0);
});

test("multiple chunks cover all primary sources and C sees uncited context as well", async () => {
  const messages = Array.from({ length: 70 }, (_, i) => ({ ts: `${Math.floor(f.start / 1000) + 100 + i}.000000`, user: f.userId, text: i ? `합성 문맥 ${i}` : f.text }));
  send = async () => Response.json({ ok: true, messages, has_more: false });
  const run = await create(); await drain();
  const output = await readRunArtifacts(imageDeps(), run.id);
  expect(output.manifest.sourceCount).toBe(70); expect(output.manifest.chunkCount).toBe(2);
  expect(paid.filter(name => name === "teamplanet_evidence_v1")).toHaveLength(2);
  expect(inputs.find(row => row.name === "teamplanet_review_v1")!.input.parts).toHaveLength(70);
  expect(output.evidence).toHaveLength(2);
});

test("a final transaction failure leaves no partial publication and retries a saved normalized output without paying again", async () => {
  f.sqlite.run("CREATE TRIGGER synthetic_publish_failure BEFORE INSERT ON analysis_outputs BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
  const run = await create(); await drain(() => (f.sqlite.query("SELECT COUNT(*) AS n FROM job_failures").get() as any).n > 0);
  expect(count("analysis_outputs")).toBe(0); expect(count("assessments")).toBe(0); expect(count("evidence_events")).toBe(0);
  expect(count("analysis_stage_results")).toBe(2); expect(paid).toHaveLength(3);
  f.sqlite.run("DROP TRIGGER synthetic_publish_failure"); await drain();
  expect((await readRunArtifacts(imageDeps(), run.id)).candidate.assessments).toHaveLength(1);
  expect(paid).toHaveLength(3); expect(count("analysis_stage_results")).toBe(3);
});

test("cancellation while a model runs revokes its lease and never publishes or resumes it", async () => {
  cancelAt = "teamplanet_review_v1"; const run = await create(); await drain();
  expect(count("analysis_outputs")).toBe(0); expect(count("assessments")).toBe(0); expect(paid).toHaveLength(3);
  const result = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(result.status).toBe("cancelled"); expect(result.valid).toBe(false);
  expect((await call(`/analysis-runs/${run.id}/resume`, {})).status).toBe(409);
});

for (const [http, expectedStatus, expectedCode] of [[401, "failed_provider_auth", "PROVIDER_AUTH"], [403, "failed_model", "PROVIDER_POLICY"], [503, "failed_model", "UPSTREAM_UNAVAILABLE"], [200, "failed_model", "UPSTREAM_UNAVAILABLE"]] as const) {
  test(`HTTP ${http} remains a technical/auth failure, never billing or a false completion`, async () => {
    failStage = "teamplanet_assessment_v1"; status = http; const run = await create(); await drain();
    const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
    expect(state.status).toBe(expectedStatus); expect(state.errors.some(error => error.code === expectedCode)).toBe(true);
    expect(state.errors.some(error => error.code === "PROVIDER_BILLING_BLOCKED")).toBe(false);
    expect(paid.filter(name => name === "teamplanet_evidence_v1")).toHaveLength(1); expect(count("analysis_outputs")).toBe(0);
    expect(JSON.stringify(f.sqlite.query("SELECT stage_metadata_json FROM analysis_runs").all())).not.toContain("private-source-token");
    expect(state.errors.every(error => !error.retryable)).toBe(true);
  });
}

test("an explicit in-flight 402 delay is retried while a key-limit 402 is not", async () => {
  failStage = "teamplanet_assessment_v1"; status = 402; limitSource = "openrouter_in_flight_budget"; const run = await create();
  await drain(() => paid.length === 2);
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state.errors.find(error => error.code === "PROVIDER_BILLING_BLOCKED")).toMatchObject({ retryable: true, retryAfterSeconds: 11, billing: { kind: "in_flight_budget" } });
  failStage = null; await drain(); expect((await readRunArtifacts(imageDeps(), run.id)).receipts).toHaveLength(3);
});

test("a remote edit invalidates a published candidate and is never hidden by a saved output", async () => {
  const run = await create(); await drain();
  send = async () => Response.json({ ok: true, messages: [{ ts: f.slackTs, user: f.userId, text: `${f.text} 수정`, edited: { ts: `${Math.floor(f.start / 1000) + 150}.000000` } }], has_more: false });
  expect((await call(`/analysis-runs/${run.id}/artifacts`)).status).toBe(409);
  expect(analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json()).status).toBe("failed_data");
  expect(count("analysis_outputs")).toBe(1);
});

test("oversized whole-run context fails explicitly after full A coverage instead of sampling B/C input", async () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({ ts: `${Math.floor(f.start / 1000) + 100 + i}.000000`, user: f.userId,
    text: "synthetic context ".repeat(1600), edited: { ts: `${Math.floor(f.start / 1000) + 150 + i}.000000` } }));
  send = async () => Response.json({ ok: true, messages, has_more: false });
  const run = await create(); await drain();
  const state = analysisRunResponseSchema.parse(await (await call(`/analysis-runs/${run.id}`)).json());
  expect(state).toMatchObject({ status: "failed_model", errors: expect.arrayContaining([expect.objectContaining({ code: "CONTEXT_LIMIT" })]) });
  expect(paid.every(name => name === "teamplanet_evidence_v1")).toBe(true); expect(state.progress.completedChunks).toBe(state.progress.chunks);
  expect(count("analysis_outputs")).toBe(0);
});

test("image bytes are verified transiently for A; whole-run B/C retain author metadata without retaining or sending image copies", async () => {
  const chunk = (kind: string, bytes: Uint8Array) => {
    const out = new Uint8Array(bytes.length + 12); new DataView(out.buffer).setUint32(0, bytes.length);
    out.set(new TextEncoder().encode(kind), 4); out.set(bytes, 8); let crc = 0xffffffff;
    for (const b of out.subarray(4, -4)) { crc ^= b; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    new DataView(out.buffer).setUint32(out.length - 4, (crc ^ 0xffffffff) >>> 0); return out;
  };
  const header = new Uint8Array(13); new DataView(header.buffer).setUint32(0, 1); new DataView(header.buffer).setUint32(4, 1); header[8] = 8; header[9] = 6;
  const png = new Uint8Array([137,80,78,71,13,10,26,10, ...chunk("IHDR", header), ...chunk("IDAT", deflateSync(new Uint8Array([0,0,0,0,255]))), ...chunk("IEND", new Uint8Array())]);
  const file = { id: "FSYNTH001", user: f.userId, mimetype: "image/png", size: png.length, updated: 1, url_private_download: "https://files.slack.com/files-pri/TSYNTH001-FSYNTH001/download/image.png" };
  send = async url => url.endsWith("files.info") ? Response.json({ ok: true, file }) : url.includes("files.slack.com")
    ? new Response(png, { headers: { "Content-Type": "image/png" } })
    : Response.json({ ok: true, messages: [{ ts: f.slackTs, user: f.userId, text: f.text, files: [{ id: file.id }] }], has_more: false });
  const run = await create(); await drain();
  const output = await readRunArtifacts(imageDeps(), run.id);
  expect(output.evidence[0]!.imageIds).toHaveLength(1);
  expect(inputs.find(row => row.name === "teamplanet_evidence_v1")!.wire).toContain("data:image/png;base64,");
  for (const row of inputs.filter(row => row.name !== "teamplanet_evidence_v1")) expect(row.wire).not.toContain("data:image");
  const serialized = JSON.stringify(output); expect(serialized).not.toContain("data:image"); expect(serialized).not.toContain("files.slack.com");
});
