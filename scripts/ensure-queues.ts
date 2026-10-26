import { cloudflareRequest, findQueue, QUEUES, type CfRequest } from "./cloudflare";

// Idempotent provisioning; existing queue settings/retention/pause state stay intact.
export async function ensureQueues(api: CfRequest) {
  for (const name of QUEUES) {
    if (await findQueue(api, name)) continue;
    await api("/queues", "POST", { queue_name: name });
  }
}
if (import.meta.main) {
  try { await ensureQueues(cloudflareRequest()); console.log("Production work queue and DLQ are available; Consumer is deployed before producers."); }
  catch (error) { console.error(error instanceof Error ? error.message : "QUEUE_PROVISION_FAILED"); process.exitCode = 1; }
}
