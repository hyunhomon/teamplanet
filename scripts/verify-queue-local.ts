import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { convertV4MiniflareOptions, Miniflare, type V4MiniflareOptions } from "miniflare";
import { jobKey, type QueueEnvelope, type QueueJob } from "../packages/contracts/src/jobs";
import { flushOutbox, JobStore } from "../packages/queue/src/index";
import { localEgress, localModelBindings, localPaidCalls, localProviderFetch, localReceiptCalls, localRunId, seedLocalAnalysis } from "../tests/fixtures/analysis-queue";
import type { D1Database, Queue } from "@cloudflare/workers-types";

const root = resolve(import.meta.dir, "..");
const cache = join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const runDir = process.env.TEAMPLANET_QUEUE_RUN_DIR ?? mkdtempSync(join(cache, "queue-local-"));
const consumerConfig = JSON.parse(readFileSync(join(root, "apps/consumer/wrangler.jsonc"), "utf8"));
const source = consumerConfig.queues.consumers[0];
const entrypoints = [join(root, "tests/fixtures/queue-producer.ts"), join(root, "tests/fixtures/queue-consumer.ts")];
if (!process.env.TEAMPLANET_QUEUE_NODE_RUNNER) {
  const compiled = await Bun.build({ entrypoints, outdir: runDir, root, target: "browser", format: "esm" });
  if (!compiled.success) throw new Error(`Local queue bundle failed: ${compiled.logs.join("\n")}`);
  // Bun 1.3.14 on Windows can panic after Miniflare.dispose(), even after all assertions pass.
  // Keep Bun for the pinned build; run the actual simulator lifecycle under required Node 24.
  const runner = await Bun.build({ entrypoints: [import.meta.path], target: "node", format: "esm", external: ["miniflare", "drizzle-orm/migrator", "zod"],
    outdir: join(runDir, "runner"), define: { "import.meta.dir": JSON.stringify(import.meta.dir) } });
  if (!runner.success) throw new Error(`Local queue runner build failed: ${runner.logs.join("\n")}`);
  const child = Bun.spawn(["node", runner.outputs[0]!.path], { stdin: "ignore", stdout: "inherit", stderr: "inherit",
    env: { ...process.env, TEAMPLANET_QUEUE_NODE_RUNNER: "1", TEAMPLANET_QUEUE_RUN_DIR: runDir } });
  process.exit(await child.exited);
}
const d1Databases = { DB: "queue-local-isolated" };
// Miniflare validates these options at startup. Avoid expanding its generated Zod
// option union at every nested Worker in the repository's TypeScript check.
const options = {
  defaultPersistRoot: join(runDir, "state"),
  workers: [
    { name: "local-producer", modules: true, scriptPath: join(runDir, "tests/fixtures/queue-producer.js"), compatibilityDate: consumerConfig.compatibility_date,
      d1Databases, queueProducers: { WORK_QUEUE: source.queue } },
    { name: consumerConfig.name, modules: true, scriptPath: join(runDir, "tests/fixtures/queue-consumer.js"), compatibilityDate: consumerConfig.compatibility_date,
      bindings: localModelBindings, outboundService: localProviderFetch,
      d1Databases, queueProducers: { WORK_QUEUE: source.queue, DEAD_LETTER_QUEUE: source.dead_letter_queue },
      queueConsumers: { [source.queue]: {
        maxBatchSize: source.max_batch_size, maxBatchTimeout: source.max_batch_timeout,
        maxRetries: source.max_retries, retryDelay: source.retry_delay, deadLetterQueue: source.dead_letter_queue,
      } } },
    { name: "local-dlq-observer", modules: true, compatibilityDate: consumerConfig.compatibility_date, d1Databases,
      queueConsumers: { [source.dead_letter_queue]: { maxBatchSize: 1, maxBatchTimeout: 0 } },
      script: `export default { async queue(batch, env) {
        for (const message of batch.messages) {
          await env.DB.prepare('INSERT INTO synthetic_dlq (message_id) VALUES (?) ON CONFLICT DO NOTHING').bind(message.id).run();
          message.ack();
        }
      } }` },
  ],
};
const mf = new Miniflare(convertV4MiniflareOptions(options as unknown as V4MiniflareOptions));
try {
  const db = await mf.getD1Database("DB", "local-producer");
  for (const migration of readMigrationFiles({ migrationsFolder: join(root, "packages/db/migrations") })) {
    await db.batch(migration.sql.map(sql => db.prepare(sql.trim())));
  }
  await db.prepare("CREATE TABLE synthetic_dlq (message_id text PRIMARY KEY)").run();
  await db.prepare("CREATE TABLE synthetic_deliveries (message_id text PRIMARY KEY, job_key text NOT NULL)").run();
  const probe: QueueJob = { kind: "system.probe", probeId: crypto.randomUUID() };
  const key = jobKey(probe);
  const harness = await mf.getWorker("local-producer");
  const response = await harness.fetch("http://localhost/probe", { method: "POST", body: JSON.stringify(probe) });
  strictEqual(response.status, 200);
  const waitFor = async (label: string, predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 90_000;
    while (!await predicate()) {
      if (Date.now() > deadline) {
        console.error(JSON.stringify({ label, runs: (await db.prepare("SELECT id,status,stage_metadata_json FROM analysis_runs").all()).results,
          jobs: (await db.prepare("SELECT job_key,status,attempts,error_code FROM queue_jobs").all()).results,
          calls: (await db.prepare("SELECT stage,status,generation_id,error_code FROM analysis_calls").all()).results, paid: localPaidCalls, receipts: localReceiptCalls }));
        throw new Error(`Local queue timeout: ${label}`);
      }
      await sleep(100);
    }
    console.log(`PASS: ${label}`);
  };
  await waitFor("producer -> Queue -> Consumer -> D1", async () =>
    (await db.prepare("SELECT status FROM queue_jobs WHERE job_key = ?").bind(key).first<{ status: string }>())?.status === "completed");
  const producer = await mf.getQueueProducer<QueueEnvelope>("WORK_QUEUE", "local-producer");
  await producer.send({ version: 1, generation: 0, job: probe });
  await waitFor("completed redelivery remains a single execution", async () =>
    (await db.prepare("SELECT count(*) AS count FROM synthetic_deliveries WHERE job_key = ?").bind(key).first<{ count: number }>())!.count >= 2);
  deepStrictEqual(await db.prepare("SELECT attempts FROM queue_jobs WHERE job_key = ?").bind(key).first(), { attempts: 1 });
  deepStrictEqual(await db.prepare("SELECT count(*) AS count FROM job_checkpoints WHERE job_key = ?").bind(key).first(), { count: 2 });
  const missingRun: QueueJob = { kind: "analysis.stage", runId: `run_${crypto.randomUUID()}`, stage: "review", chunkId: "run_0" };
  await harness.fetch("http://localhost/probe", { method: "POST", body: JSON.stringify(missingRun) });
  await waitFor("a nonexistent analysis run reaches application DLQ without model access", async () =>
    (await db.prepare("SELECT count(*) AS count FROM synthetic_dlq").first<{ count: number }>())!.count >= 1);
  deepStrictEqual(await db.prepare("SELECT status,error_code FROM queue_jobs WHERE job_key = ?").bind(jobKey(missingRun)).first(), { status: "dead", error_code: "DATA_INVALIDATED" });
  // Full production handler, actual local Queue/D1, and an egress mock which cannot reach real services.
  await seedLocalAnalysis(db as unknown as D1Database);
  await harness.fetch("http://localhost/probe", { method: "POST", body: JSON.stringify({ kind: "analysis.prepare", runId: localRunId }) });
  const store = new JobStore(db as unknown as D1Database), deadQueue = await mf.getQueueProducer<QueueEnvelope>("DEAD_LETTER_QUEUE", consumerConfig.name);
  await waitFor("actual Queue/D1 A -> B -> C with metadata-only retry reaches professor review", async () => {
    await flushOutbox(store, producer as unknown as Queue<QueueEnvelope>, deadQueue as unknown as Queue<QueueEnvelope>);
    const state = await db.prepare("SELECT status,stage_metadata_json FROM analysis_runs WHERE id = ?").bind(localRunId).first<{ status: string; stage_metadata_json: string | null }>();
    const jobs = await db.prepare("SELECT status,error_code FROM queue_jobs WHERE json_extract(job_json,'$.runId') = ?").bind(localRunId).all();
    if (jobs.results.some(row => row.status === "dead")) throw new Error(`Local analysis failed: ${JSON.stringify({ state, jobs: jobs.results, paid: localPaidCalls, receipts: localReceiptCalls, egress: localEgress })}`);
    return state?.status === "awaiting_professor";
  });
  deepStrictEqual(localPaidCalls, ["teamplanet_evidence_v1", "teamplanet_assessment_v1", "teamplanet_review_v1"]);
  strictEqual(localReceiptCalls.filter(id => id === "gen-local-1").length, 2);
  strictEqual((await db.prepare("SELECT count(*) AS count FROM assessments WHERE run_id = ?").bind(localRunId).first<{ count: number }>())!.count, 1);
  const output = (await db.prepare("SELECT output_json FROM analysis_outputs WHERE run_id = ?").bind(localRunId).first<{ output_json: string }>())!.output_json;
  strictEqual(output.includes("합성 큐 모델 통합 자료"), false); strictEqual(output.includes("synthetic-only-key"), false);
  // Deliberately bypass the validated producer to verify platform max_retries -> native DLQ.
  const invalidProducer = await mf.getQueueProducer<unknown>("WORK_QUEUE", "local-producer");
  await invalidProducer.send({ version: 999, kind: "synthetic.unknown" });
  await waitFor("unknown envelope exhausts native retries and reaches DLQ", async () =>
    (await db.prepare("SELECT count(*) AS count FROM synthetic_dlq").first<{ count: number }>())!.count >= 2);
  strictEqual((await db.prepare("SELECT count(*) AS count FROM queue_rejections").first<{ count: number }>())!.count, 1);
  deepStrictEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  console.log("PASS: isolated local Worker/Queue/D1 round trip, duplicate delivery, application/native DLQ and schema constraints.");
} finally { await mf.dispose(); }
