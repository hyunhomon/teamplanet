import type { D1Database } from "@cloudflare/workers-types";
import { analysisSnapshotSchema, jobKey, manifestHeaderSchema, manifestVersion, chunkPlanSchema, evidenceInputSchema,
  type AnalysisSnapshot, type EvidenceInput, type QueueJob, type ChunkPlan, type Part } from "@teamplanet/contracts";
import { dataEpochGuard, invalidateTeam, processingWriteGuard, recoverHistory, runValidityGuard, sha256Hex, sourceWriteGuard, withMessageImages,
  type ImageDeps, type SourceRef } from "@teamplanet/collection";
import { JobError, LeaseLost, type JobContext } from "@teamplanet/queue";
import { modelProfile } from "@teamplanet/ai-core";
import { analysisId, planChunks, sourceParts } from "./planner";

export const snapshot = (rubric: AnalysisSnapshot["rubric"]) => analysisSnapshotSchema.parse({ contractVersion: "analysis-stages-v1", rubric,
  modelProfileVersion: modelProfile.version, promptVersion: modelProfile.promptVersion, configuredModel: modelProfile.model, configuredProvider: modelProfile.provider,
  contextPlanVersion: "qwen-chunks-v1", contextLength: 262144, maxTextBytes: 48000, maxImagesPerChunk: 1 });
export function outboxInsert(db: D1Database, job: QueueJob, now: number) {
  return db.prepare("INSERT INTO queue_jobs (job_key, job_json, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_key) DO NOTHING")
    .bind(jobKey(job), JSON.stringify(job), now, now);
}
export type Spec = { run_id: string; team_id: string; professor_id: string; request_hash: string; idempotency_key: string; version: number; timezone: string;
  snapshot_json: string; students_json: string; manifest_json: string | null; from_ts: string; to_ts: string; status: string };
export const loadSpec = (db: D1Database, runId: string) => db.prepare("SELECT s.*, r.from_ts, r.to_ts, r.status FROM analysis_specs s JOIN analysis_runs r ON r.id = s.run_id WHERE s.run_id = ?").bind(runId).first<Spec>();
type Source = { id: string; channel_id: string; slack_ts: string; ref_json: string; student_id: string; text_length: number; parts_json: string; attachments_json: string };
export async function* runSources(db: D1Database, runId: string) {
  let after = "";
  while (true) {
    const rows = await db.prepare("SELECT * FROM analysis_sources WHERE run_id = ? AND slack_ts > ? ORDER BY slack_ts LIMIT 100").bind(runId, after).all<Source>();
    if (!rows.results.length) return;
    for (const source of rows.results) yield source;
    after = rows.results.at(-1)!.slack_ts;
  }
}
function preparingGuard(db: D1Database, spec: Spec, now: number) {
  return [processingWriteGuard(db, { teamId: spec.team_id, from: Date.parse(spec.from_ts), to: Date.parse(spec.to_ts), now }),
    db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM analysis_runs WHERE id = ? AND status = 'collecting')
      AND ? = (SELECT json_group_array(json_object('id', id, 'displayName', display_name)) FROM
        (SELECT s.id, s.display_name FROM students s JOIN team_members m ON m.student_id = s.id WHERE m.team_id = ? ORDER BY s.id))
      THEN '1' ELSE 'run_stopped' END)`).bind(spec.run_id, spec.students_json, spec.team_id)];
}
/** No raw payload in checkpoint or tables. Re-reads allowed history, then processes one message at a time. */
export async function prepareRun(deps: ImageDeps, runId: string, context: JobContext) {
  if (await context.checkpoint("prepared")) return;
  const db = deps.db, spec = await loadSpec(db, runId);
  if (!spec || !["queued", "collecting"].includes(spec.status)) throw new JobError("DATA_INVALID", false);
  const from = Date.parse(spec.from_ts), to = Date.parse(spec.to_ts);
  try {
    await db.batch([processingWriteGuard(db, { teamId: spec.team_id, from, to, now: deps.now() }),
      db.prepare("UPDATE analysis_runs SET status = 'collecting' WHERE id = ? AND status = 'queued'").bind(runId)]);
    const course = await db.prepare("SELECT c.ends_at FROM courses c JOIN teams t ON t.course_id = c.id WHERE t.id = ?").bind(spec.team_id).first<{ ends_at: number }>();
    const requestId = runId.slice(4);
    if (course!.ends_at > deps.now()) await recoverHistory(deps, { requestId, teamId: spec.team_id, fromMs: from, toMs: to }, context);
    const coverage = await db.prepare(`SELECT * FROM collection_coverage WHERE team_id = ? AND from_ms <= ? AND to_ms >= ? AND status = 'complete'
      AND (? = 0 OR request_id = ?) ORDER BY updated_at DESC LIMIT 1`)
      .bind(spec.team_id, from, to, Number(course!.ends_at > deps.now()), requestId).first<any>();
    if (!coverage) throw new JobError("DATA_INVALID", false);
    let after = "";
    while (true) {
      const rows = await db.prepare(`SELECT channel_id, slack_ts, thread_ts FROM message_refs WHERE team_id = ? AND slack_ts > ?
        AND CAST(slack_ts AS REAL) * 1000 >= ? AND CAST(slack_ts AS REAL) * 1000 < ? AND deleted_at IS NULL AND content_hash IS NOT NULL ORDER BY slack_ts LIMIT 50`)
        .bind(spec.team_id, after, from, to).all<{ channel_id: string; slack_ts: string; thread_ts: string | null }>();
      if (!rows.results.length) break;
      for (const row of rows.results) {
        const checkpoint = `s${(await analysisId("message", `${runId}:${row.channel_id}:${row.slack_ts}`)).slice(8).replaceAll("-", "")}`;
        if (await context.checkpoint(checkpoint)) {
          const saved = await db.prepare("SELECT ref_json, attachments_json FROM analysis_sources WHERE run_id = ? AND channel_id = ? AND slack_ts = ?").bind(runId, row.channel_id, row.slack_ts).first<any>();
          await withMessageImages({ ...deps, requestedFileIds: [] }, { teamId: spec.team_id, channelId: row.channel_id, slackTs: row.slack_ts }, async memory => {
            if (!saved || saved.ref_json !== JSON.stringify(memory.source.ref) || JSON.parse(saved.attachments_json).map((a: any) => a.fileId).sort().join() !== memory.attachmentIds.join()) throw new JobError("DATA_INVALID", false);
          });
        } else await withMessageImages(deps, { teamId: spec.team_id, channelId: row.channel_id, slackTs: row.slack_ts }, async memory => {
          const id = await analysisId("message", `${runId}:${row.channel_id}:${row.slack_ts}`);
          const threadId = row.thread_ts ? await analysisId("message", `${runId}:${row.channel_id}:${row.thread_ts}`) : null;
          const attachments: { id: string; fileId: string; fileRevision: string | null; hash: string | null; limitation: string | null }[] = [];
          for (const file of memory.attachmentIds) {
            const metadata = await db.prepare("SELECT file_revision, content_hash, limitation FROM image_refs WHERE channel_id = ? AND slack_ts = ? AND file_id = ?").bind(row.channel_id, row.slack_ts, file).first<any>();
            attachments.push({ id: await analysisId("image", `${id}:${file}`), fileId: file, fileRevision: metadata?.file_revision ?? null, hash: metadata?.content_hash ?? null, limitation: metadata ? metadata.limitation : "file_unavailable" });
          }
          const parts = sourceParts(id, memory.source.text, threadId, attachments.map(a => a.id), memory.limitations);
          await memory.assertCurrent();
          await context.commit(checkpoint, id, [...preparingGuard(db, spec, deps.now()), ...sourceWriteGuard(db, memory.source.ref, deps.now()),
            db.prepare(`INSERT INTO analysis_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, id) DO NOTHING`)
              .bind(runId, id, row.channel_id, row.slack_ts, JSON.stringify(memory.source.ref), memory.source.studentId, memory.source.text.length, JSON.stringify(parts), JSON.stringify(attachments))]);
        });
        await context.heartbeat();
      }
      after = rows.results.at(-1)!.slack_ts;
    }
    const allParts: Part[] = [], hashes: string[] = [];
    let sources = 0;
    for await (const row of runSources(db, runId)) {
      sources++; allParts.push(...JSON.parse(row.parts_json));
      hashes.push(await sha256Hex(JSON.stringify([row.ref_json, row.parts_json, row.attachments_json])));
    }
    const chunks = planChunks(allParts);
    const epoch = (await db.prepare("SELECT epoch FROM team_data_versions WHERE team_id = ?").bind(spec.team_id).first<{ epoch: number }>())!.epoch;
    const manifest = manifestHeaderSchema.parse({ version: manifestVersion, hash: await sha256Hex(JSON.stringify(hashes)), epoch,
      sourceCount: sources, partCount: allParts.length, chunkCount: chunks.length, coverageRequestId: coverage.request_id,
      coverageAsOf: new Date(coverage.updated_at).toISOString(), limitations: JSON.parse(coverage.limitations_json) });
    // A source changed while another message was being hydrated: do not attach a new epoch to stale sources.
    const referenceGuard = db.prepare(`SELECT json(CASE WHEN NOT EXISTS (SELECT 1 FROM analysis_sources a LEFT JOIN message_refs m ON m.channel_id = a.channel_id AND m.slack_ts = a.slack_ts
      WHERE a.run_id = ? AND (m.team_id IS NOT ? OR m.deleted_at IS NOT NULL OR m.revision IS NOT json_extract(a.ref_json,'$.revision')
        OR m.content_hash IS NOT json_extract(a.ref_json,'$.contentHash') OR m.user_id IS NOT json_extract(a.ref_json,'$.userId')))
      AND (SELECT COUNT(*) FROM analysis_sources WHERE run_id = ?) = (SELECT COUNT(*) FROM message_refs
        WHERE team_id = ? AND deleted_at IS NULL AND content_hash IS NOT NULL AND CAST(slack_ts AS REAL) * 1000 >= ? AND CAST(slack_ts AS REAL) * 1000 < ?)
      THEN '1' ELSE 'dataset_changed' END)`).bind(runId, spec.team_id, runId, spec.team_id, from, to);
    const writes = [...preparingGuard(db, spec, deps.now()), dataEpochGuard(db, spec.team_id, epoch), referenceGuard,
      db.prepare(`SELECT json(CASE WHEN NOT EXISTS (SELECT 1 FROM analysis_sources a, json_each(a.attachments_json) j
        LEFT JOIN image_refs i ON i.channel_id = a.channel_id AND i.slack_ts = a.slack_ts AND i.file_id = json_extract(j.value,'$.fileId')
        WHERE a.run_id = ? AND (i.file_id IS NULL OR i.file_revision IS NOT json_extract(j.value,'$.fileRevision')
          OR i.content_hash IS NOT json_extract(j.value,'$.hash') OR i.limitation IS NOT json_extract(j.value,'$.limitation')))
        THEN '1' ELSE 'image_changed' END)`).bind(runId),
      db.prepare("INSERT INTO run_data_validity (run_id, team_id, data_epoch) VALUES (?, ?, ?)").bind(runId, spec.team_id, epoch),
      db.prepare("UPDATE analysis_specs SET manifest_json = ? WHERE run_id = ?").bind(JSON.stringify(manifest), runId),
      db.prepare("UPDATE analysis_runs SET status = 'evidence_extraction' WHERE id = ?").bind(runId)];
    for (let offset = 0; offset < chunks.length; offset += 50) {
      await context.commit(`plan${offset / 50}`, `parts:${offset}`, [...preparingGuard(db, spec, deps.now()),
        ...chunks.slice(offset, offset + 50).map((chunk, i) => db.prepare("INSERT INTO analysis_chunks VALUES (?, ?, ?, ?) ON CONFLICT(run_id,id) DO NOTHING").bind(runId, chunk.id, offset + i, JSON.stringify(chunk)))]);
    }
    writes.push(db.prepare(`INSERT INTO queue_jobs (job_key, job_json, created_at, updated_at)
      SELECT 'run:' || run_id || ':evidence_extraction:' || id, json_object('kind','analysis.stage','runId',run_id,'stage','evidence_extraction','chunkId',id), ?, ?
      FROM analysis_chunks WHERE run_id = ? ON CONFLICT(job_key) DO NOTHING`).bind(deps.now(), deps.now(), runId));
    writes.unshift(db.prepare(`WITH expected AS (SELECT json_extract(p.value,'$.id') AS id FROM analysis_sources s, json_each(s.parts_json) p WHERE s.run_id = ?),
      actual AS (SELECT json_extract(p.value,'$.id') AS id FROM analysis_chunks c, json_each(c.plan_json,'$.parts') p WHERE c.run_id = ?)
      SELECT json(CASE WHEN (SELECT COUNT(*) FROM actual) = (SELECT COUNT(*) FROM expected)
        AND (SELECT COUNT(DISTINCT id) FROM actual) = (SELECT COUNT(*) FROM expected)
        AND NOT EXISTS (SELECT id FROM expected EXCEPT SELECT id FROM actual)
        AND (SELECT COUNT(*) FROM analysis_chunks WHERE run_id = ?) = ? THEN '1' ELSE 'chunk_coverage_changed' END)`)
      .bind(runId, runId, runId, chunks.length));
    await context.commit("prepared", manifest.hash, writes);
  } catch (error) {
    if (error instanceof LeaseLost) throw error;
    // Transient transport failure preserves checkpoints; retry must revalidate them before promotion.
    if (error instanceof JobError && error.retryable || (error as any)?.code === "SLACK_UNAVAILABLE" && (error as any).retryable) throw new JobError("UPSTREAM_UNAVAILABLE", true);
    if (!(error instanceof JobError) && !["SOURCE_BLOCKED", "SOURCE_CHANGED", "SOURCE_DELETED", "SLACK_UNAVAILABLE"].includes((error as any)?.code)) throw new JobError("UPSTREAM_UNAVAILABLE", true);
    await db.prepare("UPDATE analysis_runs SET status = 'failed_data' WHERE id = ? AND status IN ('queued','collecting')").bind(runId).run();
    throw new JobError("DATA_INVALID", false);
  }
}
/** Streaming nested callbacks keep images in scope until the caller returns, then clear every data URL. */
export async function withChunkInput<T>(deps: ImageDeps, runId: string, chunkId: string, use: (input: EvidenceInput, assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  const db = deps.db, spec = await loadSpec(db, runId);
  if (!spec?.manifest_json || spec.status === "cancelled") throw new Error("DATA_INVALIDATED");
  const planRow = await db.prepare("SELECT plan_json FROM analysis_chunks WHERE run_id = ? AND id = ?").bind(runId, chunkId).first<{ plan_json: string }>();
  if (!planRow) throw new Error("CHUNK_NOT_FOUND");
  const plan = chunkPlanSchema.parse(JSON.parse(planRow.plan_json));
  const wanted = [...plan.context, ...plan.parts], ids = [...new Set(wanted.map(p => p.messageId))];
  const parts: EvidenceInput["parts"] = [], checks: (() => Promise<void>)[] = [];
  const assertCurrent = async () => { await runValidityGuard(db, runId, deps.now()).run(); for (const check of checks) await check(); };
  async function load(index: number): Promise<T> {
    await runValidityGuard(db, runId, deps.now()).run();
    if (index === ids.length) {
      const input = evidenceInputSchema.parse({ version: "analysis-stages-v1", runId, chunkId, selection: JSON.parse(spec!.snapshot_json).rubric,
        students: JSON.parse(spec!.students_json), parts, primaryPartIds: plan.parts.map(p => p.id), limitations: [...JSON.parse(spec!.manifest_json!).limitations, ...plan.limitations],
        period: { from: spec!.from_ts, to: spec!.to_ts, timezone: spec!.timezone } });
      try { await assertCurrent(); return await use(input, assertCurrent); }
      finally { for (const p of input.parts) { p.text = ""; for (const image of p.images) image.dataUrl = ""; } }
    }
    const row = await db.prepare("SELECT * FROM analysis_sources WHERE run_id = ? AND id = ?").bind(runId, ids[index]!).first<Source>();
    if (!row) throw new Error("SOURCE_UNAVAILABLE");
    const requestedFiles = (JSON.parse(row.attachments_json) as any[]).filter(a => wanted.some(p => p.messageId === row.id && p.imageIds.includes(a.id))).map(a => a.fileId);
    return withMessageImages({ ...deps, requestedFileIds: requestedFiles }, { teamId: spec!.team_id, channelId: row.channel_id, slackTs: row.slack_ts }, async memory => {
      const ref: SourceRef = JSON.parse(row.ref_json);
      const attachments: any[] = JSON.parse(row.attachments_json);
      const invalid = async (): Promise<never> => { await invalidateTeam(db, spec!.team_id, "manifest_changed", deps.now()).run(); throw new Error("DATA_INVALIDATED"); };
      if (JSON.stringify(ref) !== JSON.stringify(memory.source.ref) || attachments.map(a => a.fileId).sort().join() !== memory.attachmentIds.join()) return invalid();
      for (const attachment of attachments) {
        const current = await db.prepare("SELECT file_revision, content_hash, limitation FROM image_refs WHERE channel_id = ? AND slack_ts = ? AND file_id = ?").bind(row.channel_id, row.slack_ts, attachment.fileId).first<any>();
        if (!current || current.file_revision !== attachment.fileRevision || current.content_hash !== attachment.hash || current.limitation !== attachment.limitation) return invalid();
      }
      checks.push(memory.assertCurrent);
      for (const p of wanted.filter(p => p.messageId === row.id)) parts.push({ ...p, text: memory.source.text.slice(p.start, p.end), studentId: row.student_id, sentAt: new Date(Math.floor(Number(row.slack_ts) * 1000)).toISOString(),
        images: attachments.filter(a => p.imageIds.includes(a.id)).flatMap(a => { const image = memory.images.find(i => i.fileId === a.fileId); return image ? [{ id: a.id, dataUrl: image.dataUrl, studentId: image.studentId, limitations: image.limitations }] : []; }) });
      try { return await load(index + 1); } finally { for (const p of parts) { p.text = ""; for (const image of p.images) image.dataUrl = ""; } }
    });
  }
  return load(0);
}
