import { Hono, type Context } from "hono";
import type { D1Database, Queue } from "@cloudflare/workers-types";
import type { QueueEnvelope } from "@teamplanet/contracts";
import { collectionGate, SLACK_TS, slackTsMs, type EventKind } from "@teamplanet/collection";
import { dispatchJob, JobStore } from "@teamplanet/queue";
import { encoder, sha256 } from "./auth";
import { apiError } from "./errors";

export type EventBindings = { DB: D1Database; WORK_QUEUE: Queue<QueueEnvelope>; SLACK_SIGNING_SECRET?: string };
const MAX_SKEW_SECONDS = 5 * 60;
const EVENT_ID = /^Ev[A-Z0-9]{6,}$/;

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], byte => parseInt(byte, 16));
/** Slack request signing v0: HMAC-SHA256 over `v0:<timestamp>:<raw body>`, compared in constant time by WebCrypto. */
export async function verifySlackSignature(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, nowSeconds: number) {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signature || !/^v0=[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, fromHex(signature.slice(3)), encoder.encode(`v0:${timestamp}:${body}`));
}

type Classified = { kind: EventKind; channelId: string | null; slackTs: string | null; threadTs: string | null; userId: string | null; revision: string | null; text?: string } | { ignore: string };
// Untrusted Slack JSON: every field used is checked here; text is only hashed and never leaves this function's caller.
const str = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null);
const ts = (value: unknown) => (typeof value === "string" && SLACK_TS.test(value) ? value : null);
function classify(event: Record<string, unknown>): Classified {
  const type = event.type;
  if (type === "app_uninstalled") return { kind: "revoked", channelId: null, slackTs: null, threadTs: null, userId: null, revision: null };
  if (type === "tokens_revoked") {
    const bots = (event.tokens as { bot?: unknown } | undefined)?.bot;
    return Array.isArray(bots) && bots.length ? { kind: "revoked", channelId: null, slackTs: null, threadTs: null, userId: null, revision: null } : { ignore: "user_token" };
  }
  if (type === "member_joined_channel" || type === "member_left_channel") {
    const channelId = str(event.channel); const userId = str(event.user);
    if (!channelId || !userId) return { ignore: "malformed" };
    return { kind: type === "member_joined_channel" ? "member_joined" : "member_left", channelId, slackTs: null, threadTs: null, userId, revision: null };
  }
  if (type !== "message") return { ignore: "event_type" };
  // Only public channels; DMs, group DMs and private channels are never collected.
  if (event.channel_type !== "channel") return { ignore: "not_public_channel" };
  const channelId = str(event.channel);
  if (!channelId) return { ignore: "malformed" };
  const subtype = event.subtype;
  if (subtype === "message_deleted") {
    const deleted = ts(event.deleted_ts); const revision = ts(event.ts);
    return deleted && revision ? { kind: "message_deleted", channelId, slackTs: deleted, threadTs: null, userId: null, revision } : { ignore: "malformed" };
  }
  const message = (subtype === "message_changed" ? event.message : event) as Record<string, unknown> | undefined;
  if (subtype !== undefined && subtype !== "message_changed" && subtype !== "thread_broadcast" && subtype !== "file_share") return { ignore: "subtype" };
  if (!message || message.bot_id !== undefined || message.subtype === "bot_message") return { ignore: "bot" };
  const slackTs = ts(message.ts); const userId = str(message.user);
  const revision = subtype === "message_changed" ? ts((message.edited as { ts?: unknown } | undefined)?.ts) ?? ts(event.event_ts) : slackTs;
  if (!slackTs || !userId || !revision) return { ignore: "malformed" };
  return {
    kind: subtype === "message_changed" ? "message_changed" : "message", channelId, slackTs, threadTs: ts(message.thread_ts), userId, revision,
    text: typeof message.text === "string" ? message.text : "",
  };
}

/** POST /v1/slack/events — signature first, then ack fast; the consumer re-checks the gate before storing. */
export function eventRoutes(now: () => number) {
  const routes = new Hono<{ Bindings: EventBindings }>();
  routes.post("/slack/events", async context => {
    const secret = context.env.SLACK_SIGNING_SECRET;
    if (!secret) return apiError(context, "SLACK_UNAVAILABLE", "Slack 이벤트 수신이 설정되지 않았습니다.");
    const body = await context.req.text();
    const valid = await verifySlackSignature(secret, context.req.header("X-Slack-Request-Timestamp"), context.req.header("X-Slack-Signature"), body, Math.floor(now() / 1000));
    if (!valid) return apiError(context, "UNAUTHENTICATED", "Slack 서명을 확인할 수 없습니다.");
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(body); } catch { return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요."); }
    if (payload.type === "url_verification" && typeof payload.challenge === "string") return context.json({ challenge: payload.challenge }, 200);
    if (payload.type !== "event_callback" || typeof payload.event_id !== "string" || !EVENT_ID.test(payload.event_id)) return context.body(null, 200);
    return accept(context, payload as Record<string, unknown> & { event_id: string });
  });

  async function accept(context: Context<{ Bindings: EventBindings }>, payload: Record<string, unknown> & { event_id: string }) {
    const db = context.env.DB;
    const at = now();
    const installation = await db.prepare(`SELECT w.id, w.slack_team_id, i.app_id FROM slack_installations i JOIN workspaces w ON w.id = i.workspace_id`)
      .first<{ id: string; slack_team_id: string; app_id: string }>();
    // Nothing but the id and the reason is kept for events we do not collect.
    const ignore = async (reason: string) => {
      if (installation) {
        await db.prepare(`INSERT INTO slack_event_refs (event_ref, workspace_id, event_id, kind, outcome, received_at, processed_at)
          VALUES (?, ?, ?, 'ignored', ?, ?, ?) ON CONFLICT (event_id) DO NOTHING`)
          .bind(`event_${crypto.randomUUID()}`, installation.id, payload.event_id, `ignored:${reason}`, at, at).run();
      }
      return context.body(null, 200);
    };
    if (!installation || payload.team_id !== installation.slack_team_id || payload.api_app_id !== installation.app_id) return ignore("workspace");
    if (await db.prepare("SELECT 1 FROM slack_event_refs WHERE event_id = ?").bind(payload.event_id).first()) return context.body(null, 200); // Slack retry
    const event = classify((payload.event ?? {}) as Record<string, unknown>);
    if ("ignore" in event) return ignore(event.ignore);

    let teamId: string | null = null;
    if (event.channelId) {
      const team = await db.prepare("SELECT id FROM teams WHERE workspace_id = ? AND channel_id = ?").bind(installation.id, event.channelId).first<{ id: string }>();
      if (!team) return ignore("channel");
      teamId = team.id;
      // First gate check at intake. Deletions always pass (a tombstone only removes); unknown authors pass so the consumer can stop the channel.
      if (event.kind === "message" || event.kind === "message_changed") {
        const gate = await collectionGate(db, { teamId, at: slackTsMs(event.slackTs!), now: at, slackUserId: event.userId! });
        if (!gate.allowed && gate.reason !== "unknown_participant") return ignore(gate.reason);
      }
      if (event.kind === "member_joined" || event.kind === "member_left") {
        const gate = await collectionGate(db, { teamId, at, now: at });
        if (!gate.allowed) return ignore(gate.reason);
      }
    }

    const eventRef = `event_${crypto.randomUUID()}`;
    const contentHash = event.text === undefined ? null : await sha256(event.text);
    const inserted = await db.prepare(`INSERT INTO slack_event_refs (event_ref, workspace_id, event_id, kind, team_id, channel_id, slack_ts, thread_ts,
        user_id, revision, content_hash, outcome, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT (event_id) DO NOTHING`)
      .bind(eventRef, installation.id, payload.event_id, event.kind, teamId, event.channelId, event.slackTs, event.threadTs, event.userId, event.revision, contentHash, at).run();
    if (!inserted.meta.changes) return context.body(null, 200);
    const store = new JobStore(db, now);
    let row;
    try {
      row = await store.register({ kind: "slack.event", workspaceId: installation.id, eventId: payload.event_id, eventRef });
    } catch {
      // Not durable yet: drop our ref so Slack's retry of the same event_id is processed again.
      await db.prepare("DELETE FROM slack_event_refs WHERE event_ref = ?").bind(eventRef).run();
      console.error("slack.event_enqueue_failed", "register");
      return apiError(context, "SLACK_UNAVAILABLE", "이벤트를 접수하지 못했습니다.", { retryable: true });
    }
    try {
      await dispatchJob(store, context.env.WORK_QUEUE, row);
    } catch {
      console.error("slack.event_enqueue_failed", "dispatch"); // durable outbox; the consumer cron sends it
    }
    return context.body(null, 200);
  }

  return routes;
}
