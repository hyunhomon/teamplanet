import { dev } from "astro";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Use a new cache without deleting a collaborator's dev state. No readiness HTTP request or retry
// may warm the routes before the assertion: the first request must already render successfully.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.ASTRO_TELEMETRY_DISABLED = "1";
process.env.WRANGLER_SEND_METRICS = "false";
const parent = join(root, "node_modules/.cache");
mkdirSync(parent, { recursive: true });
const isolated = mkdtempSync(join(parent, "dev-cold-"));
const server = await dev({ root: join(root, "apps/web"), cacheDir: join(isolated, "astro"),
  vite: { cacheDir: join(isolated, "vite") }, server: { host: "127.0.0.1", port: 4397 } });
try {
  for (const path of ["/login", "/workspace", "/consent/confirm"]) {
    const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { signal: AbortSignal.timeout(30000) });
    const html = await response.text();
    assert.equal(response.status, 200, `first ${path}: HTTP ${response.status}`);
    assert.ok(html.includes("TeamPlanet") && html.includes("astro-island"), `${path}: expected SSR island`);
    assert.doesNotMatch(html, /fetch failed|Invalid hook call|AstroError/, `${path}: error screen`);
    console.log(`PASS cold first ${path}: HTTP 200, rendered SSR island`);
  }
} finally { await server.stop(); }
