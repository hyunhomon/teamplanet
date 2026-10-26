import { jobKey, type QueueEnvelope, type QueueJob } from "../packages/contracts/src/jobs";
import { cloudflareRequest, findQueue, PRODUCTION_DATABASE, type CfRequest } from "./cloudflare";

export async function smokeQueue(api: CfRequest, sleep: (ms: number) => Promise<unknown> = Bun.sleep) {
  const queue = await findQueue(api, "teamplanet-jobs");
  if (!queue) throw new Error("Production work queue is missing.");
  const job: QueueJob = { kind: "system.probe", probeId: crypto.randomUUID() };
  const key = jobKey(job);
  const envelope: QueueEnvelope = { version: 1, generation: 0, job };
  // Direct HTTP publication exercises the deployed Consumer without a public test endpoint.
  // A duplicate checks the durable job key; no student data or external model/mail calls.
  for (let i = 0; i < 2; i++) await api(`/queues/${queue.queue_id}/messages`, "POST", { body: envelope, content_type: "json" });
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await api<{ results: { status: string; attempts: number; checkpoints: number }[] }[]>(
      `/d1/database/${PRODUCTION_DATABASE}/query`, "POST", {
        sql: `SELECT status, attempts, (SELECT count(*) FROM job_checkpoints WHERE job_key = ?) AS checkpoints FROM queue_jobs WHERE job_key = ?`,
        params: [key, key],
      });
    const row = result[0]?.results[0];
    if (row?.status === "completed") {
      if (row.attempts !== 1 || row.checkpoints !== 2) throw new Error("Production queue probe violated execution/checkpoint invariants.");
      return key;
    }
    if (row?.status === "dead") throw new Error("Production queue probe reached a terminal failure; inspect the job ledger.");
    await sleep(1000);
  }
  throw new Error("Production queue probe timed out; inspect Consumer binding, retries, cron and job ledger.");
}
if (import.meta.main) {
  try { console.log(`Production queue smoke passed: ${await smokeQueue(cloudflareRequest())}`); }
  catch (error) { console.error(error instanceof Error ? error.message : "QUEUE_SMOKE_FAILED"); process.exitCode = 1; }
}
