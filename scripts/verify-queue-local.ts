import { deepStrictEqual, strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { convertV4MiniflareOptions, Miniflare, type V4MiniflareOptions } from "miniflare";
import { jobKey, type QueueEnvelope, type QueueJob } from "../packages/contracts/src/jobs";

const root = resolve(import.meta.dir, "..");
const cache = join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const runDir = mkdtempSync(join(cache, "queue-local-"));
const consumerConfig = JSON.parse(readFileSync(join(root, "apps/consumer/wrangler.jsonc"), "utf8"));
const source = consumerConfig.queues.consumers[0];
const entrypoints = [join(root, "tests/fixtures/queue-producer.ts"), join(root, "tests/fixtures/queue-consumer.ts")];
const compiled = await Bun.build({ entrypoints, outdir: runDir, root, target: "browser", format: "esm" });
if (!compiled.success) throw new Error(`Local queue bundle failed: ${compiled.logs.join("\n")}`);
const d1Databases = { DB: "queue-local-isolated" };
// Miniflare validates these options at startup. Avoid expanding its generated Zod
// option union at every nested Worker in the repository's TypeScript check.
const options = {
  defaultPersistRoot: join(runDir, "state"),
  workers: [
    { name: "local-producer", modules: true, scriptPath: join(runDir, "tests/fixtures/queue-producer.js"), compatibilityDate: consumerConfig.compatibility_date,
      d1Databases, queueProducers: { WORK_QUEUE: source.queue } },
    { name: consumerConfig.name, modules: true, scriptPath: join(runDir, "tests/fixtures/queue-consumer.js"), compatibilityDate: consumerConfig.compatibility_date,
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
      if (Date.now() > deadline) throw new Error(`Local queue timeout: ${label}`);
      await Bun.sleep(100);
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
  const unregistered: QueueJob = { kind: "analysis.stage", runId: `run_${crypto.randomUUID()}`, stage: "review", chunkId: "synthetic-1" };
  await harness.fetch("http://localhost/probe", { method: "POST", body: JSON.stringify(unregistered) });
  await waitFor("unregistered handler reaches application DLQ", async () =>
    (await db.prepare("SELECT count(*) AS count FROM synthetic_dlq").first<{ count: number }>())!.count >= 1);
  strictEqual((await db.prepare("SELECT status FROM queue_jobs WHERE job_key = ?").bind(jobKey(unregistered)).first<{ status: string }>())!.status, "dead");
  // Deliberately bypass the validated producer to verify platform max_retries -> native DLQ.
  const invalidProducer = await mf.getQueueProducer<unknown>("WORK_QUEUE", "local-producer");
  await invalidProducer.send({ version: 999, kind: "synthetic.unknown" });
  await waitFor("unknown envelope exhausts native retries and reaches DLQ", async () =>
    (await db.prepare("SELECT count(*) AS count FROM synthetic_dlq").first<{ count: number }>())!.count >= 2);
  strictEqual((await db.prepare("SELECT count(*) AS count FROM queue_rejections").first<{ count: number }>())!.count, 1);
  deepStrictEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
  console.log("PASS: isolated local Worker/Queue/D1 round trip, duplicate delivery, application/native DLQ and schema constraints.");
} finally { await mf.dispose(); }
