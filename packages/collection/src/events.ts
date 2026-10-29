import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { collectionGate, pauseTeam } from "./index";

export type EventKind = "message" | "message_changed" | "message_deleted" | "member_joined" | "member_left" | "revoked";
export type EventRefRow = {
  event_ref: string; workspace_id: string; kind: EventKind; team_id: string | null; channel_id: string | null;
  slack_ts: string | null; thread_ts: string | null; user_id: string | null; revision: string | null; content_hash: string | null;
};
export type MessageRef = {
  teamId: string; channelId: string; slackTs: string; userId: string | null; threadTs: string | null;
  revision: string; contentHash: string | null; source: "event" | "history";
};

/** Slack ts "1700000000.000100" → epoch ms (sub-ms digits dropped; ordering uses the ts strings). */
export const slackTsMs = (ts: string) => Math.floor(Number(ts) * 1000);
export const SLACK_TS = /^\d{10}\.\d{6}$/;

/**
 * Idempotent merge of one message reference. A newer revision wins; equal or older ones change nothing.
 * Tombstoned rows never come back, so a create/edit arriving after a delete cannot resurrect the message.
 * ponytail: revisions compare as text, which orders correctly while Slack ts keep 10.6 digits (until 2286).
 */
export function mergeMessage(db: D1Database, ref: MessageRef, now: number, verifiedAt: number | null = null): D1PreparedStatement {
  return db.prepare(`INSERT INTO message_refs (team_id, channel_id, slack_ts, user_id, thread_ts, revision, content_hash, source, first_seen_at, updated_at, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (channel_id, slack_ts) DO UPDATE SET
      revision = CASE WHEN excluded.revision > message_refs.revision THEN excluded.revision ELSE message_refs.revision END,
      content_hash = CASE WHEN excluded.revision > message_refs.revision THEN excluded.content_hash ELSE message_refs.content_hash END,
      user_id = COALESCE(message_refs.user_id, excluded.user_id), thread_ts = COALESCE(message_refs.thread_ts, excluded.thread_ts),
      updated_at = excluded.updated_at, verified_at = COALESCE(excluded.verified_at, message_refs.verified_at)
    WHERE message_refs.deleted_at IS NULL`)
    .bind(ref.teamId, ref.channelId, ref.slackTs, ref.userId, ref.threadTs, ref.revision, ref.contentHash, ref.source, now, now, verifiedAt);
}
/** Tombstone: keeps only channel + ts (no author, no fingerprint) so a late create or edit stays dead. */
export function tombstone(db: D1Database, teamId: string, channelId: string, slackTs: string, revision: string, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO message_refs (team_id, channel_id, slack_ts, user_id, thread_ts, revision, content_hash, deleted_at, source, first_seen_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, 'event', ?, ?)
    ON CONFLICT (channel_id, slack_ts) DO UPDATE SET content_hash = NULL,
      deleted_at = COALESCE(message_refs.deleted_at, excluded.deleted_at), updated_at = excluded.updated_at`)
    .bind(teamId, channelId, slackTs, revision, now, now, now);
}

/** What one stored Slack event should do now, after re-checking the gate right before writing. */
export async function planEvent(db: D1Database, ref: EventRefRow, now: number): Promise<{ outcome: string; writes: D1PreparedStatement[] }> {
  if (ref.kind === "revoked") {
    const { results } = await db.prepare("SELECT id FROM teams WHERE workspace_id = ? AND collection_status = 'active'").bind(ref.workspace_id).all<{ id: string }>();
    return {
      outcome: "revoked",
      writes: [
        db.prepare("UPDATE slack_installations SET token_ciphertext = NULL, revoked_at = ? WHERE workspace_id = ? AND token_ciphertext IS NOT NULL").bind(now, ref.workspace_id),
        ...results.flatMap(team => pauseTeam(db, team.id, "slack_revoked", now)),
      ],
    };
  }
  const teamId = ref.team_id!;
  if (ref.kind === "message_deleted") return { outcome: "tombstoned", writes: [tombstone(db, teamId, ref.channel_id!, ref.slack_ts!, ref.revision!, now)] };

  if (ref.kind === "member_joined" || ref.kind === "member_left") {
    const bot = await db.prepare("SELECT bot_user_id FROM slack_installations WHERE workspace_id = ?").bind(ref.workspace_id).first<{ bot_user_id: string }>();
    const gate = await collectionGate(db, { teamId, at: now, now, ...(ref.user_id ? { slackUserId: ref.user_id } : {}) });
    if (!gate.allowed && ["team_inactive", "policy_not_approved", "course_ended"].includes(gate.reason)) return { outcome: `ignored:${gate.reason}`, writes: [] };
    if (ref.kind === "member_left") {
      if (ref.user_id === bot?.bot_user_id) return { outcome: "paused:bot_removed", writes: pauseTeam(db, teamId, "bot_removed", now) };
      const member = await db.prepare(`SELECT 1 FROM team_members m JOIN student_slack_mappings s ON s.student_id = m.student_id
        WHERE m.team_id = ? AND s.slack_user_id = ?`).bind(teamId, ref.user_id).first();
      return member ? { outcome: "paused:member_left", writes: pauseTeam(db, teamId, "member_left", now) } : { outcome: "ignored:not_member", writes: [] };
    }
    if (ref.user_id === bot?.bot_user_id || gate.allowed) return { outcome: "ignored:known_member", writes: [] };
    // Anyone joining without a valid consent stops the channel until the professor and operator check it.
    return { outcome: "paused:unknown_participant", writes: pauseTeam(db, teamId, "unknown_participant", now) };
  }

  const gate = await collectionGate(db, { teamId, at: slackTsMs(ref.slack_ts!), now, slackUserId: ref.user_id! });
  if (!gate.allowed) {
    if (gate.reason === "unknown_participant") return { outcome: "paused:unknown_participant", writes: pauseTeam(db, teamId, "unknown_participant", now) };
    return { outcome: `ignored:${gate.reason}`, writes: [] };
  }
  return {
    outcome: "stored",
    writes: [mergeMessage(db, {
      teamId, channelId: ref.channel_id!, slackTs: ref.slack_ts!, userId: ref.user_id, threadTs: ref.thread_ts,
      revision: ref.revision!, contentHash: ref.content_hash, source: "event",
    }, now)],
  };
}
