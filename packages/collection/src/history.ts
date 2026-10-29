import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { JobError, type JobContext } from "@teamplanet/queue";
import { collectionGate } from "./index";
import { mergeMessage, SLACK_TS, slackTsMs } from "./events";
import { callSlack, openToken, sha256Hex, type SlackFetch } from "./slack";

/**
 * History/Replies recovery (#12). Re-reads Slack only inside the team's allowed windows ∩ [fromMs, toMs),
 * merges references idempotently with the Events path, keeps text in memory only and records coverage for #16.
 *
 * Boundaries: a window is [startedAt, endedAt) in epoch ms; Slack ts "s.micro" maps to ms by flooring.
 * We query `oldest`/`latest` inclusively and keep messages with start <= ts < end ourselves.
 */
export type HistoryDeps = { db: D1Database; send: SlackFetch; tokenKey?: string; now: () => number };
export type HistoryJob = { requestId: string; teamId: string; fromMs: number; toMs: number };

const PAGE_LIMIT = "200";
// Failures that a retry cannot fix: coverage fails loudly instead of looking like "no messages".
const permanentErrors = new Set([
  "missing_scope", "not_in_channel", "channel_not_found", "is_archived", "access_denied",
  "invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired",
]);
// Every coverage carries this: replies to threads older than the window are only found through Events (#11).
const STANDING_LIMITATIONS = ["older_thread_replies_from_events_only"];
const msToTs = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
// Checkpoint references allow only [A-Za-z0-9_:/.-]; Slack cursors are base64.
const encodeCursor = (cursor: string) => cursor.replaceAll("+", "-").replaceAll("=", ".");
const decodeCursor = (reference: string) => reference.replaceAll("-", "+").replaceAll(".", "=");
const validTs = (value: unknown) => (typeof value === "string" && SLACK_TS.test(value) ? value : null);
class Stop extends Error { constructor(readonly reason: string) { super(reason); } }

type Counters = { merged: number; excluded: number };

export async function recoverHistory(deps: HistoryDeps, job: HistoryJob, context: JobContext) {
  const { db, now } = deps;
  const { requestId, teamId, fromMs, toMs } = job;
  if (!(fromMs < toMs)) throw new JobError("DATA_INVALID", false);
  if (await context.checkpoint("done")) return;
  const team = await db.prepare("SELECT channel_id, workspace_id FROM teams WHERE id = ?").bind(teamId).first<{ channel_id: string; workspace_id: string }>();
  if (!team) throw new JobError("REFERENCE_NOT_FOUND", false);
  const channel = team.channel_id;

  // The run start stamps every message seen; refs older than this run and not seen again were deleted in Slack.
  const started = await context.checkpoint("start");
  const runStart = started ? Number(started.reference) : now();
  if (!started) {
    await context.commit("start", String(runStart), [db.prepare(`INSERT INTO collection_coverage (request_id, team_id, from_ms, to_ms, status, started_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?) ON CONFLICT (request_id) DO NOTHING`).bind(requestId, teamId, fromMs, toMs, runStart, runStart)]);
  }
  const progress = (counters: Counters, extra: string = "") => db.prepare(`UPDATE collection_coverage SET merged = merged + ?, excluded = excluded + ?${extra}, updated_at = ? WHERE request_id = ?`);
  const finish = (status: "complete" | "partial" | "failed", reason: string | null, limitations: string[]) =>
    context.commit("done", reason ? `${status}:${reason}` : status, [db.prepare("UPDATE collection_coverage SET status = ?, reason = ?, limitations_json = ?, updated_at = ? WHERE request_id = ?")
      .bind(status, reason, JSON.stringify(limitations), now(), requestId)]);

  const teamGate = async () => {
    const gate = await collectionGate(db, { teamId, at: now(), now: now() });
    if (!gate.allowed) throw new Stop(gate.reason);
  };
  let token = "";
  async function slack(method: string, params: Record<string, string>) {
    let result;
    try {
      result = await callSlack(deps.send, token, method, params);
    } catch {
      throw new JobError("UPSTREAM_UNAVAILABLE", true);
    }
    if (result.ok) return result.body;
    if (result.error === "ratelimited") throw new JobError("RATE_LIMITED", true, result.retryAfter ?? 30);
    if (permanentErrors.has(result.error)) throw new Stop(result.error);
    throw new JobError("UPSTREAM_UNAVAILABLE", true);
  }

  /** Merge one Slack message if it is a human message inside [a, b) by a consented member; otherwise only mark it seen. */
  async function take(message: Record<string, any>, a: number, b: number, writes: D1PreparedStatement[], counters: Counters) {
    const ts = validTs(message.ts);
    if (!ts || slackTsMs(ts) < a || slackTsMs(ts) >= b) return;
    const subtype = message.subtype;
    const human = (subtype === undefined || subtype === "thread_broadcast" || subtype === "file_share") && message.bot_id === undefined && typeof message.user === "string";
    const gate = human ? await collectionGate(db, { teamId, at: slackTsMs(ts), now: now(), slackUserId: message.user }) : null;
    if (!gate?.allowed) {
      if (human) counters.excluded++;
      // Seen in Slack, so not deleted; its use is decided by the consent gate (#14 handles invalidation).
      writes.push(db.prepare("UPDATE message_refs SET verified_at = ? WHERE channel_id = ? AND slack_ts = ? AND deleted_at IS NULL").bind(runStart, channel, ts));
      return;
    }
    counters.merged++;
    writes.push(mergeMessage(db, {
      teamId, channelId: channel, slackTs: ts, userId: message.user, threadTs: validTs(message.thread_ts),
      revision: validTs(message.edited?.ts) ?? ts, contentHash: await sha256Hex(typeof message.text === "string" ? message.text : ""), source: "history",
    }, now(), runStart));
  }
  /** Refs in [a, b) that this run should have seen but did not: deleted in Slack. Counted before they are tombstoned. */
  function sweep(writes: D1PreparedStatement[], a: number, b: number, scope: string, scopeValue?: string) {
    const where = `team_id = ? AND channel_id = ? AND slack_ts >= ? AND slack_ts < ? AND deleted_at IS NULL AND ${scope}
      AND first_seen_at < ? AND (verified_at IS NULL OR verified_at < ?)`;
    const args = [teamId, channel, msToTs(a), msToTs(b), ...(scopeValue === undefined ? [] : [scopeValue, scopeValue]), runStart, runStart];
    writes.push(
      db.prepare(`UPDATE collection_coverage SET tombstoned = tombstoned + (SELECT COUNT(*) FROM message_refs WHERE ${where}) WHERE request_id = ?`).bind(...args, requestId),
      db.prepare(`UPDATE message_refs SET deleted_at = ?, content_hash = NULL, updated_at = ? WHERE ${where}`).bind(runStart, runStart, ...args),
    );
  }
  async function thread(root: string, a: number, b: number, writes: D1PreparedStatement[], counters: Counters) {
    let cursor: string | undefined;
    do {
      const page = await slack("conversations.replies", {
        channel, ts: root, oldest: msToTs(a), latest: msToTs(b), inclusive: "true", limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}),
      });
      for (const reply of Array.isArray(page.messages) ? page.messages : []) if (reply?.ts !== root) await take(reply, a, b, writes, counters);
      cursor = page.has_more && page.response_metadata?.next_cursor ? String(page.response_metadata.next_cursor) : undefined;
      await context.heartbeat();
    } while (cursor);
    sweep(writes, a, b, "thread_ts = ? AND slack_ts <> ?", root);
  }

  async function interval(index: number, a: number, b: number) {
    // Resume after the last committed page of this interval.
    let page = 0;
    let cursor: string | undefined;
    let done = false;
    for (let cp = await context.checkpoint(`h${index}p0`); cp; cp = await context.checkpoint(`h${index}p${page}`)) {
      if (cp.reference === "end") { done = true; break; }
      cursor = decodeCursor(cp.reference);
      page++;
    }
    while (!done) {
      await teamGate();
      const body = await slack("conversations.history", {
        channel, oldest: msToTs(a), latest: msToTs(b), inclusive: "true", limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}),
      });
      const writes: D1PreparedStatement[] = [];
      const counters = { merged: 0, excluded: 0 };
      for (const message of Array.isArray(body.messages) ? body.messages : []) {
        await take(message, a, b, writes, counters);
        const ts = validTs(message?.ts);
        if (ts && Number(message.reply_count) > 0 && message.thread_ts === ts && slackTsMs(ts) >= a && slackTsMs(ts) < b) await thread(ts, a, b, writes, counters);
      }
      const next = body.has_more && body.response_metadata?.next_cursor ? String(body.response_metadata.next_cursor) : undefined;
      if (next && encodeCursor(next).length > 200) throw new JobError("DATA_INVALID", false);
      if (!next) sweep(writes, a, b, "(thread_ts IS NULL OR thread_ts = slack_ts)");
      writes.push(progress(counters).bind(counters.merged, counters.excluded, now(), requestId));
      await context.commit(`h${index}p${page}`, next ? encodeCursor(next) : "end", writes);
      await context.heartbeat();
      cursor = next;
      page++;
      done = !next;
    }
    // In-window replies to threads that started before the window (known from Events). Their roots stay out of scope.
    if (!await context.checkpoint(`h${index}old`)) {
      const { results } = await db.prepare(`SELECT DISTINCT thread_ts FROM message_refs WHERE team_id = ? AND channel_id = ?
        AND slack_ts >= ? AND slack_ts < ? AND thread_ts IS NOT NULL AND thread_ts < ?`).bind(teamId, channel, msToTs(a), msToTs(b), msToTs(a)).all<{ thread_ts: string }>();
      const writes: D1PreparedStatement[] = [];
      const counters = { merged: 0, excluded: 0 };
      for (const { thread_ts: root } of results) await thread(root, a, b, writes, counters);
      writes.push(progress(counters, ", old_thread_roots = old_thread_roots + ?").bind(counters.merged, counters.excluded, results.length, now(), requestId));
      await context.commit(`h${index}old`, String(results.length), writes);
    }
  }

  try {
    await teamGate();
    const installation = await db.prepare("SELECT token_ciphertext FROM slack_installations WHERE workspace_id = ? AND token_ciphertext IS NOT NULL")
      .bind(team.workspace_id).first<{ token_ciphertext: string }>();
    if (!installation || !deps.tokenKey) throw new Stop("slack_not_connected");
    token = await openToken(deps.tokenKey, team.workspace_id, installation.token_ciphertext);

    const { results: windows } = await db.prepare("SELECT started_at, ended_at FROM collection_windows WHERE team_id = ? ORDER BY started_at, id")
      .bind(teamId).all<{ started_at: number; ended_at: number | null }>();
    const at = now();
    const intervals = windows
      .map(w => [Math.max(w.started_at, fromMs), Math.min(w.ended_at ?? at, toMs)] as const)
      .filter(([a, b]) => a < b);
    for (const [index, [a, b]] of intervals.entries()) await interval(index, a, b);

    const covered = intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
    const row = (await db.prepare("SELECT excluded, old_thread_roots FROM collection_coverage WHERE request_id = ?").bind(requestId).first<{ excluded: number; old_thread_roots: number }>())!;
    const limitations = [
      ...(covered < toMs - fromMs ? ["outside_allowed_window"] : []),
      ...(row.excluded > 0 ? ["unconsented_author_excluded"] : []),
      ...(row.old_thread_roots > 0 ? ["thread_root_outside_window"] : []),
      ...STANDING_LIMITATIONS,
    ];
    await finish(covered < toMs - fromMs ? "partial" : "complete", null, limitations);
  } catch (error) {
    if (error instanceof Stop) {
      await finish("failed", error.reason, STANDING_LIMITATIONS);
      return;
    }
    throw error;
  }
}
