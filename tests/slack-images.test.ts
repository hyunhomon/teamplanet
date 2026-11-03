import { afterEach, beforeEach, expect, test } from "bun:test";
import { IMAGE_LIMITS, withMessageImages, type MemoryImage } from "@teamplanet/collection";
import { deflateSync } from "node:zlib";
import { collectionFixture } from "./helpers/collection";

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of out.subarray(4, 8 + data.length)) {
    crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0); return out;
}
const header = new Uint8Array(13); new DataView(header.buffer).setUint32(0, 1); new DataView(header.buffer).setUint32(4, 1); header[8] = 8; header[9] = 6;
const PNG = new Uint8Array([137,80,78,71,13,10,26,10, ...chunk("IHDR", header), ...chunk("IDAT", deflateSync(new Uint8Array([0,0,0,0,255]))), ...chunk("IEND", new Uint8Array())]);
const FILE = "FSYNTH001";
let f: Awaited<ReturnType<typeof collectionFixture>>;
let file: Record<string, any>, message: Record<string, any>, calls: { url: string; init: RequestInit }[];
let reply: () => Promise<Response>;
beforeEach(async () => {
  f = await collectionFixture(); calls = [];
  file = { id: FILE, user: f.userId, mimetype: "image/png", size: PNG.length, updated: 1, url_private_download: `https://files.slack.com/files-pri/TSYNTH001-${FILE}/download/image.png` };
  message = { ts: f.slackTs, user: f.userId, text: f.text, files: [{ id: FILE }] };
  reply = async () => new Response(PNG, { headers: { "Content-Type": "image/png" } });
});
afterEach(() => f.sqlite.close());
async function send(url: string, init: RequestInit) {
  calls.push({ url, init });
  expect(init.redirect).toBe("manual");
  if (url.includes("/api/conversations.")) return Response.json({ ok: true, messages: [message], has_more: false });
  if (url.endsWith("/api/files.info")) return Response.json({ ok: true, file });
  return reply();
}
const deps = () => ({ db: f.db, send, tokenKey: f.tokenKey, now: f.now });
const run = () => withMessageImages(deps(), f.target, async input => ({ count: input.images.length, limitations: input.limitations }));

test("consented attachment becomes memory-only model input and only hashes/refs persist", async () => {
  let retained: MemoryImage | undefined;
  const result = await withMessageImages(deps(), f.target, async input => {
    retained = input.images[0]; expect(retained?.dataUrl).toStartWith("data:image/png;base64,");
    expect(JSON.stringify(input.source)).not.toContain("xoxb");
    await input.assertCurrent(); return input.images.length;
  });
  expect(result).toBe(1); expect(retained?.dataUrl).toBe("");
  const persisted = JSON.stringify(f.sqlite.query("SELECT * FROM image_refs").all());
  expect(persisted).toContain(FILE);
  for (const secret of ["xoxb", "files.slack.com", "data:image", f.text]) expect(persisted).not.toContain(secret);
});

for (const url of ["https://evil.invalid/files-pri/TSYNTH001-FSYNTH001/a", "https://files.slack.com.evil.invalid/files-pri/TSYNTH001-FSYNTH001/a",
  "http://files.slack.com/files-pri/TSYNTH001-FSYNTH001/a", "https://user:pass@files.slack.com/files-pri/TSYNTH001-FSYNTH001/a", "https://files.slack.com/files-pri/TSYNTH001-FOTHER001/a"]) {
  test(`reject forged URL ${url}`, async () => {
    file.url_private_download = url;
    expect(await run()).toMatchObject({ count: 0, limitations: ["unsafe_download"] });
    expect(calls.every(call => call.url.startsWith("https://slack.com/api/"))).toBe(true);
  });
}
test("cross-host redirect never receives the Slack authorization header", async () => {
  reply = async () => new Response(null, { status: 302, headers: { Location: "https://evil.invalid/capture" } });
  expect((await run()).limitations).toContain("unsafe_download");
  expect(calls.some(call => call.url.includes("evil.invalid"))).toBe(false);
});
test("private/expired files and unsupported/external content are limitations, never complete image coverage", async () => {
  reply = async () => new Response(null, { status: 403 });
  expect((await run()).limitations).toContain("file_unavailable");
  file.mode = "external";
  expect((await run()).limitations).toContain("unsafe_download");
  file.mode = "hosted"; file.mimetype = "image/svg+xml";
  expect((await run()).limitations).toContain("unsupported_format");
});
test("MIME spoofing, truncated files, advertised/streamed size overflow and timeouts fail closed", async () => {
  reply = async () => new Response("<html>synthetic</html>", { headers: { "Content-Type": "image/png" } });
  expect((await run()).limitations).toContain("invalid_image");
  reply = async () => new Response(PNG.slice(0, 20), { headers: { "Content-Type": "image/png" } });
  expect((await run()).limitations).toContain("invalid_image");
  reply = async () => new Response(PNG, { headers: { "Content-Type": "image/png", "Content-Length": String(IMAGE_LIMITS.bytes + 1) } });
  expect((await run()).limitations).toContain("image_too_large");
  reply = async () => new Response(new Uint8Array(IMAGE_LIMITS.bytes + 1), { headers: { "Content-Type": "image/png" } });
  expect((await run()).limitations).toContain("image_too_large");
  reply = async () => { throw new DOMException("synthetic", "TimeoutError"); };
  expect((await run()).limitations).toContain("image_timeout");
});
test("withdrawal/deletion during download blocks callback, storage, and retries (no permanent cache)", async () => {
  let used = false;
  reply = async () => { f.sqlite.run("UPDATE consents SET status = 'withdrawn', recorded_at = 4"); return new Response(PNG, { headers: { "Content-Type": "image/png" } }); };
  await expect(withMessageImages(deps(), f.target, async () => { used = true; })).rejects.toThrow("SOURCE_BLOCKED");
  expect(used).toBe(false); expect(f.sqlite.query("SELECT * FROM image_refs").all()).toHaveLength(0);
  await expect(run()).rejects.toThrow("SOURCE_BLOCKED");
  f.sqlite.run("UPDATE message_refs SET deleted_at = 5, content_hash = NULL");
  await expect(run()).rejects.toThrow("SOURCE_DELETED");
});
test("different team, changed source, removed attachment and missing author never become attributed evidence", async () => {
  await expect(withMessageImages(deps(), { ...f.target, teamId: "other-team" }, async () => {})).rejects.toThrow();
  message.edited = { ts: `${Math.floor(f.start / 1000) + 200}.000000` };
  await expect(run()).rejects.toThrow("SOURCE_CHANGED");
  delete message.edited; file.user = "UUNKNOWN1";
  expect(await run()).toMatchObject({ count: 1, limitations: ["image_author_uncertain"] });
  const base = send; let reads = 0;
  await expect(withMessageImages({ ...deps(), send: async (url, init) => {
    if (url.includes("/api/conversations.") && ++reads > 1) message.files = [];
    return base(url, init);
  } }, f.target, async () => { throw new Error("must not call"); })).rejects.toThrow("SOURCE_CHANGED");
});
