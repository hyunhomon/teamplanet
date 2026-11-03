import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { SLACK_TS, slackTsMs } from "./events";
import { callSlack, openToken, sha256Hex, type SlackFetch } from "./slack";
import { observeSourceFailure, processingWriteGuard, sourceAccess } from "./lifecycle";

export const IMAGE_LIMITS = { bytes: 8 * 1024 * 1024, batchBytes: 16 * 1024 * 1024, count: 16, pixels: 40_000_000, dimension: 16_384, timeoutMs: 15_000, redirects: 2 } as const;
export type ImageLimitation = "unsupported_format" | "file_unavailable" | "unsafe_download" | "invalid_image" | "image_too_large" | "image_timeout" | "image_author_uncertain";
export class SourceUnavailable extends Error {
  constructor(readonly code: "SOURCE_BLOCKED" | "SOURCE_CHANGED" | "SOURCE_DELETED" | "SLACK_UNAVAILABLE", readonly retryable = false) { super(code); }
}
export type SourceRef = { teamId: string; channelId: string; slackTs: string; revision: string; contentHash: string; userId: string; threadTs: string | null };
type LiveSource = { ref: SourceRef; text: string; files: Record<string, any>[]; studentId: string; token: string };
export type ImageDeps = { db: D1Database; send: SlackFetch; tokenKey?: string; now: () => number; requestedFileIds?: readonly string[] };
const fileId = (id: unknown): id is string => typeof id === "string" && /^F[A-Z0-9]{8,}$/.test(id);
const boundedSend = (deps: ImageDeps): SlackFetch => (url, init) => deps.send(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(IMAGE_LIMITS.timeoutMs) });

/** Exact message revalidation; raw text, file URLs and tokens stay inside the execution. */
async function loadLiveSource(deps: ImageDeps, target: { teamId: string; channelId: string; slackTs: string }): Promise<LiveSource> {
  const row = await deps.db.prepare(`SELECT m.*, t.workspace_id FROM message_refs m JOIN teams t ON t.id = m.team_id
    WHERE m.team_id = ? AND m.channel_id = ? AND m.slack_ts = ? AND t.channel_id = m.channel_id`)
    .bind(target.teamId, target.channelId, target.slackTs).first<any>();
  if (!row || row.deleted_at !== null || !row.user_id) throw new SourceUnavailable("SOURCE_DELETED");
  if (!row.content_hash) throw new SourceUnavailable("SOURCE_CHANGED");
  const gate = await sourceAccess(deps.db, { teamId: target.teamId, at: slackTsMs(target.slackTs), now: deps.now(), slackUserId: row.user_id });
  if (!gate) throw new SourceUnavailable("SOURCE_BLOCKED");
  const installation = await deps.db.prepare("SELECT token_ciphertext FROM slack_installations WHERE workspace_id = ? AND revoked_at IS NULL").bind(row.workspace_id).first<{ token_ciphertext: string }>();
  if (!installation?.token_ciphertext || !deps.tokenKey) throw new SourceUnavailable("SLACK_UNAVAILABLE");
  let token: string;
  try { token = await openToken(deps.tokenKey, row.workspace_id, installation.token_ciphertext); } catch { throw new SourceUnavailable("SLACK_UNAVAILABLE"); }
  let response;
  try {
    response = await callSlack(boundedSend(deps), token, row.thread_ts && row.thread_ts !== row.slack_ts ? "conversations.replies" : "conversations.history", {
      channel: target.channelId, ...(row.thread_ts && row.thread_ts !== row.slack_ts ? { ts: row.thread_ts } : {}),
      oldest: target.slackTs, latest: target.slackTs, inclusive: "true", limit: "100",
    });
  } catch { throw new SourceUnavailable("SLACK_UNAVAILABLE", true); }
  if (!response.ok) throw new SourceUnavailable("SLACK_UNAVAILABLE", !["missing_scope", "invalid_auth", "not_in_channel"].includes(response.error));
  if (!Array.isArray(response.body.messages)) throw new SourceUnavailable("SLACK_UNAVAILABLE", true);
  const message = response.body.messages.find((item: any) => item?.ts === target.slackTs);
  if (!message) {
    if (response.body.has_more || response.body.response_metadata?.next_cursor) throw new SourceUnavailable("SLACK_UNAVAILABLE", true);
    throw new SourceUnavailable("SOURCE_DELETED");
  }
  if (message.subtype === "message_deleted" || message.hidden === true) throw new SourceUnavailable("SOURCE_DELETED");
  const revision = typeof message.edited?.ts === "string" ? message.edited.ts : message.ts;
  const text = typeof message.text === "string" ? message.text : "";
  if (!SLACK_TS.test(revision) || revision !== row.revision || message.user !== row.user_id || await sha256Hex(text) !== row.content_hash) throw new SourceUnavailable("SOURCE_CHANGED");
  const live = { ref: { ...target, revision, contentHash: row.content_hash, userId: row.user_id, threadTs: row.thread_ts }, text,
    files: Array.isArray(message.files) ? message.files : [], studentId: gate.studentId, token };
  await assertSourceAllowed(deps, live.ref);
  return live;
}
/** Same-transaction fence for every persistent result derived from this message. */
export function sourceWriteGuard(db: D1Database, ref: SourceRef, now: number): D1PreparedStatement[] {
  return [processingWriteGuard(db, { teamId: ref.teamId, from: slackTsMs(ref.slackTs), now, authors: [ref.userId] }),
    db.prepare(`SELECT json(CASE WHEN EXISTS (SELECT 1 FROM message_refs WHERE team_id = ? AND channel_id = ? AND slack_ts = ?
      AND revision = ? AND content_hash = ? AND user_id = ? AND deleted_at IS NULL) THEN '1' ELSE 'source_changed' END)`)
      .bind(ref.teamId, ref.channelId, ref.slackTs, ref.revision, ref.contentHash, ref.userId)];
}
export async function assertSourceAllowed(deps: ImageDeps, ref: SourceRef) {
  try { await deps.db.batch(sourceWriteGuard(deps.db, ref, deps.now())); } catch { throw new SourceUnavailable("SOURCE_BLOCKED"); }
}
function safeUrl(value: unknown, id: string): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "files.slack.com" && !url.port && !url.username && !url.password
      && url.pathname.startsWith("/files-pri/") && url.pathname.split("/").some(part => part.split("-").includes(id)) ? url : null;
  } catch { return null; }
}
/** Validate framing/dimensions rather than trusting MIME. Only PNG/JPEG are supported in v1. */
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function imageFormat(bytes: Uint8Array): { mime: "image/png" | "image/jpeg"; width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 45 && [137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) {
    let at = 8, width = 0, height = 0, data = false, end = false;
    while (at + 12 <= bytes.length) {
      const length = view.getUint32(at); if (at + length + 12 > bytes.length) return null;
      if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== view.getUint32(at + 8 + length)) return null;
      const kind = String.fromCharCode(...bytes.slice(at + 4, at + 8));
      if (at === 8) { if (kind !== "IHDR" || length !== 13) return null; width = view.getUint32(at + 8); height = view.getUint32(at + 12); }
      if (kind === "IDAT" && length > 0) data = true;
      at += length + 12;
      if (kind === "IEND") { end = length === 0 && at === bytes.length; break; }
    }
    return data && end && width > 0 && height > 0 ? { mime: "image/png", width, height } : null;
  }
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let at = 2, width = 0, height = 0;
    while (at + 4 < bytes.length) {
      if (bytes[at++] !== 255) return null;
      const marker = bytes[at++]!;
      const length = view.getUint16(at); if (length < 2 || at + length > bytes.length) return null;
      if (marker === 218) return width && height && at + length < bytes.length - 2 ? { mime: "image/jpeg", width, height } : null;
      if (marker === 217) break;
      if ([192,193,194].includes(marker) && length >= 8) {
        height = view.getUint16(at + 3); width = view.getUint16(at + 5);
      }
      at += length;
    }
  }
  return null;
}
const dataUrl = (mime: string, bytes: Uint8Array) => {
  let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
};
async function download(deps: ImageDeps, token: string, file: Record<string, any>): Promise<{ bytes: Uint8Array; mime: string } | ImageLimitation> {
  if (file.is_external || file.mode === "external" || file.filetype === "remote") return "unsafe_download";
  if (!["image/png", "image/jpeg"].includes(file.mimetype)) return "unsupported_format";
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > IMAGE_LIMITS.bytes) return "image_too_large";
  let url = safeUrl(file.url_private_download ?? file.url_private, file.id); if (!url) return "unsafe_download";
  try {
    const signal = AbortSignal.timeout(IMAGE_LIMITS.timeoutMs); let response: Response | undefined;
    for (let redirects = 0; redirects <= IMAGE_LIMITS.redirects; redirects++) {
      response = await deps.send(url.href, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal });
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get("Location"); await response.body?.cancel();
      url = safeUrl(location ? new URL(location, url).href : null, file.id);
      if (!url || redirects === IMAGE_LIMITS.redirects) return "unsafe_download";
    }
    if (!response?.ok || !response.body) return "file_unavailable";
    const declared = response.headers.get("Content-Type")?.split(";")[0]?.trim();
    if (declared !== file.mimetype) { await response.body.cancel(); return "invalid_image"; }
    const length = response.headers.get("Content-Length");
    if (length && (!/^\d+$/.test(length) || Number(length) > IMAGE_LIMITS.bytes)) { await response.body.cancel(); return "image_too_large"; }
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    while (true) {
      if (signal.aborted) { await reader.cancel(); return "image_timeout"; }
      const item = await reader.read(); if (item.done) break;
      size += item.value.length;
      if (size > IMAGE_LIMITS.bytes) { await reader.cancel(); return "image_too_large"; }
      parts.push(item.value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    const format = imageFormat(bytes);
    if (!format || format.mime !== file.mimetype || size !== file.size) return "invalid_image";
    if (format.width > IMAGE_LIMITS.dimension || format.height > IMAGE_LIMITS.dimension || format.width * format.height > IMAGE_LIMITS.pixels) return "image_too_large";
    return { bytes, mime: format.mime };
  } catch { return "image_timeout"; }
}
export type MemoryImage = { fileId: string; dataUrl: string; mime: string; studentId: string | null; limitations: ImageLimitation[] };
/** Only the callback sees image data URLs; persistent metadata contains IDs/revisions/hashes/limitations only. */
export async function withMessageImages<T>(deps: ImageDeps, target: { teamId: string; channelId: string; slackTs: string }, use: (input: {
  source: Omit<LiveSource, "token" | "files">; attachmentIds: string[]; images: MemoryImage[]; limitations: ImageLimitation[]; assertCurrent: () => Promise<void>;
}) => Promise<T>): Promise<T> {
  const live = await loadLiveSource(deps, target).catch(async error => {
    if (error instanceof SourceUnavailable && ["SOURCE_CHANGED", "SOURCE_DELETED"].includes(error.code)) await observeSourceFailure(deps.db, target, error.code === "SOURCE_DELETED", deps.now());
    throw error;
  });
  const images: MemoryImage[] = [], limitations: ImageLimitation[] = [];
  let loadedBytes = 0;
  const seen = new Set<string>();
  try {
    for (const attached of live.files) {
      if (!fileId(attached?.id)) { limitations.push("file_unavailable"); continue; }
      if (seen.has(attached.id)) continue;
      seen.add(attached.id);
      if (deps.requestedFileIds && !deps.requestedFileIds.includes(attached.id)) continue;
      await assertSourceAllowed(deps, live.ref);
      let info;
      try { info = await callSlack(boundedSend(deps), live.token, "files.info", { file: attached.id }); } catch { info = null; }
      const file = info?.ok && info.body.file?.id === attached.id ? info.body.file : null;
      const result = file ? images.length >= IMAGE_LIMITS.count || loadedBytes + Number(file.size) > IMAGE_LIMITS.batchBytes
        ? "image_too_large" : await download(deps, live.token, file) : "file_unavailable";
      await assertSourceAllowed(deps, live.ref);
      const reason: ImageLimitation | null = typeof result === "string" ? result : null;
      const author = file?.user ? await sourceAccess(deps.db, { teamId: target.teamId, at: slackTsMs(target.slackTs), now: deps.now(), slackUserId: file.user }) : null;
      const uncertain = !author?.studentId;
      if (reason) limitations.push(reason); if (uncertain) limitations.push("image_author_uncertain");
      let contentHash: string | null = null;
      if (typeof result !== "string") {
        loadedBytes += result.bytes.length;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(result.bytes)));
        contentHash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
        images.push({ fileId: attached.id, dataUrl: dataUrl(result.mime, result.bytes), mime: result.mime,
          studentId: author?.studentId ?? null, limitations: uncertain ? ["image_author_uncertain"] : [] });
        result.bytes.fill(0);
      }
      await deps.db.batch([...sourceWriteGuard(deps.db, live.ref, deps.now()), deps.db.prepare(`INSERT INTO image_refs
        (team_id, channel_id, slack_ts, file_id, source_revision, file_revision, content_hash, limitation, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(channel_id, slack_ts, file_id) DO UPDATE SET
        source_revision = excluded.source_revision, file_revision = excluded.file_revision, content_hash = excluded.content_hash,
        limitation = excluded.limitation, verified_at = excluded.verified_at`)
        .bind(target.teamId, target.channelId, target.slackTs, attached.id, live.ref.revision,
          file ? await sha256Hex(JSON.stringify([file.id, file.updated ?? file.timestamp ?? null, file.size, file.mimetype])) : null,
          contentHash, reason ?? (uncertain ? "image_author_uncertain" : null), deps.now())]);
    }
    const assertCurrent = async () => {
      await assertSourceAllowed(deps, live.ref);
      try {
        const current = await loadLiveSource(deps, target);
        if (current.ref.revision !== live.ref.revision || JSON.stringify(current.files.map(f => f.id).sort()) !== JSON.stringify(live.files.map(f => f.id).sort())) throw new SourceUnavailable("SOURCE_CHANGED");
      } catch (error) {
        if (error instanceof SourceUnavailable && ["SOURCE_CHANGED", "SOURCE_DELETED"].includes(error.code)) await observeSourceFailure(deps.db, target, error.code === "SOURCE_DELETED", deps.now());
        throw error;
      }
    };
    await assertCurrent();
    return await use({ source: { ref: live.ref, text: live.text, studentId: live.studentId }, attachmentIds: [...seen].sort(), images, limitations: [...new Set(limitations)], assertCurrent });
  } finally { for (const image of images) image.dataUrl = ""; images.length = 0; live.text = ""; live.token = ""; live.files.length = 0; }
}
