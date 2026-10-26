import { expect, test } from "bun:test";
import { ensureQueues } from "../scripts/ensure-queues";
import { cloudflareRequest, PRODUCTION_ACCOUNT, type CfRequest } from "../scripts/cloudflare";
import { smokeQueue } from "../scripts/smoke-queue-production";

test("queue provisioning creates DLQ before main queue and leaves existing queue settings alone", async () => {
  const created: string[] = [];
  const names = new Set<string>();
  const api = (async (path: string, method = "GET", body?: unknown) => {
    if (method === "GET") {
      const name = new URL(`https://example.invalid${path}`).searchParams.get("name")!;
      return names.has(name) ? [{ queue_id: name, queue_name: name }] : [];
    }
    expect(path).toBe("/queues"); expect(method).toBe("POST");
    const name = (body as { queue_name: string }).queue_name;
    names.add(name); created.push(name); return {};
  }) as CfRequest;
  await ensureQueues(api); await ensureQueues(api);
  expect(created).toEqual(["teamplanet-jobs-dlq", "teamplanet-jobs"]);
});

test("permission denial stops provisioning with concrete account/permission guidance and no secrets", async () => {
  const request = (async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-private-token");
    return Response.json({ success: false, errors: [{ code: 10000, message: "synthetic-private-provider-details" }] }, { status: 403 });
  }) as typeof fetch;
  const api = cloudflareRequest({ CLOUDFLARE_API_TOKEN: "synthetic-private-token", CLOUDFLARE_ACCOUNT_ID: PRODUCTION_ACCOUNT }, request);
  let message = "";
  try { await ensureQueues(api); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("HTTP 403"); expect(message).toContain("Queues > Edit");
  expect(message).toContain(PRODUCTION_ACCOUNT); expect(message).not.toContain("synthetic-private");
});

test("Cloudflare token cannot accidentally target another account", () => {
  expect(() => cloudflareRequest({ CLOUDFLARE_API_TOKEN: "synthetic", CLOUDFLARE_ACCOUNT_ID: "another-account" })).toThrow();
});

test("production smoke publishes reference-only duplicate probes and waits for committed results", async () => {
  const sent: unknown[] = [];
  let polls = 0;
  const api = (async (path: string, method = "GET", body?: unknown) => {
    if (method === "GET") return [{ queue_id: "synthetic", queue_name: "teamplanet-jobs" }];
    if (path.endsWith("/messages")) { sent.push(body); return {}; }
    polls++;
    return [{ results: polls > 1 ? [{ status: "completed", attempts: 1, checkpoints: 2 }] : [] }];
  }) as CfRequest;
  const key = await smokeQueue(api, async () => {});
  expect(key).toStartWith("probe:"); expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
  expect(polls).toBe(2);
  expect(Object.keys((sent[0] as { body: { job: object } }).body.job).sort()).toEqual(["kind", "probeId"]);
});

test("production smoke has a finite timeout and rejects terminal/duplicate execution failures", async () => {
  let polls = 0;
  const api = (async (path: string, method = "GET") => {
    if (method === "GET") return [{ queue_id: "synthetic", queue_name: "teamplanet-jobs" }];
    if (path.endsWith("/messages")) return {};
    polls++; return [{ results: [] }];
  }) as CfRequest;
  await expect(smokeQueue(api, async () => {})).rejects.toThrow("timed out"); expect(polls).toBe(30);
  for (const row of [{ status: "dead" }, { status: "completed", attempts: 2, checkpoints: 2 }]) {
    const failed = (async (path: string, method = "GET") => {
      if (method === "GET") return [{ queue_id: "synthetic", queue_name: "teamplanet-jobs" }];
      return path.endsWith("/messages") ? {} : [{ results: [row] }];
    }) as CfRequest;
    await expect(smokeQueue(failed, async () => {})).rejects.toThrow();
  }
});
