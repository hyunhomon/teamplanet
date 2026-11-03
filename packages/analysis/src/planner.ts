import { chunkPlanSchema, type ChunkPlan, type Part } from "@teamplanet/contracts";
import { sha256Hex } from "@teamplanet/collection";
export const MAX_TEXT_BYTES = 48000;
const encoder = new TextEncoder();
/** Deterministic opaque IDs: replay uses the same references without retaining any source text. */
export async function analysisId(prefix: string, seed: string) {
  const h = (await sha256Hex(seed)).slice(0, 32).split(""); h[12] = "4"; h[16] = "8";
  const hex = h.join(""); return `${prefix}_${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function sourceParts(messageId: string, text: string, threadId: string | null, imageIds: string[], limitations: string[] = []): Part[] {
  const out: Part[] = []; let start = 0, offset = 0, bytes = 0;
  const emit = (end: number, size: number, images: string[] = []) => out.push({ id: `part_${messageId.slice(8)}_${out.length}`, messageId, start, end, utf8Bytes: size, imageIds: images, threadId, limitations });
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (bytes + size > MAX_TEXT_BYTES / 2) { emit(offset, bytes); start = offset; bytes = 0; }
    bytes += size; offset += point.length;
  }
  if (offset > start || !imageIds.length) emit(offset, bytes);
  for (const image of imageIds) { start = offset; emit(offset, 0, [image]); }
  return out;
}
/** Primary parts partition every UTF16 range/image exactly once; context overlap never replaces primary coverage. */
export function planChunks(parts: readonly Part[]): ChunkPlan[] {
  const chunks: ChunkPlan[] = []; let current: Part[] = [], bytes = 0, images = 0;
  const flush = () => {
    if (!current.length) return;
    const previous = chunks.at(-1)?.parts.at(-1);
    const context = previous && current.length < 64 && bytes + previous.utf8Bytes <= MAX_TEXT_BYTES && images + previous.imageIds.length <= 1 ? [previous] : [];
    chunks.push(chunkPlanSchema.parse({ id: `chunk_${chunks.length}`, parts: current, context,
      limitations: chunks.length ? ["thread_context_may_span_chunks"] : [] }));
    current = []; bytes = 0; images = 0;
  };
  for (const part of parts) {
    if (part.utf8Bytes > MAX_TEXT_BYTES || part.imageIds.length > 1) throw new Error("CONTEXT_LIMIT");
    if (current.length >= 63 || bytes + part.utf8Bytes > MAX_TEXT_BYTES || images + part.imageIds.length > 1) flush();
    current.push(part); bytes += part.utf8Bytes; images += part.imageIds.length;
  }
  flush();
  if (chunks.flatMap(c => c.parts.map(p => p.id)).join() !== parts.map(p => p.id).join()) throw new Error("CHUNK_COVERAGE_INVALID");
  return chunks;
}
