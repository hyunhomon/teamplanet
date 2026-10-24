/** Draft D1 SQLite schema. Refine migrations before use. */
import { integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(), slackTeamId: text("slack_team_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull(),
  channelId: text("channel_id").notNull(), name: text("name").notNull(),
  collectionStatus: text("collection_status").notNull().default("inactive"),
});
export const consents = sqliteTable("consents", {
  teamId: text("team_id").notNull(), studentId: text("student_id").notNull(),
  status: text("status").notNull(), version: text("version").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
}, table => [primaryKey({ columns: [table.teamId, table.studentId] })]);
export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(), teamId: text("team_id").notNull(),
  slackChannelId: text("slack_channel_id").notNull(), slackTs: text("slack_ts").notNull(),
  userId: text("user_id"), threadTs: text("thread_ts"),
  text: text("text"), attachmentRefsJson: text("attachment_refs_json"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
});
export const analysisRuns = sqliteTable("analysis_runs", {
  id: text("id").primaryKey(), teamId: text("team_id").notNull(),
  fromTs: text("from_ts").notNull(), toTs: text("to_ts").notNull(),
  status: text("status").notNull(), stageMetadataJson: text("stage_metadata_json"),
  createdBy: text("created_by").notNull(),
});
export const evidenceEvents = sqliteTable("evidence_events", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(),
  messageIdsJson: text("message_ids_json").notNull(),
  actorIdsJson: text("actor_ids_json").notNull(),
  summary: text("summary").notNull(), tagsJson: text("tags_json").notNull(),
});
export const assessments = sqliteTable("assessments", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(),
  studentId: text("student_id").notNull(), competencyKey: text("competency_key").notNull(),
  judgement: text("judgement").notNull(), narrative: text("narrative").notNull(),
  evidenceIdsJson: text("evidence_ids_json").notNull(),
  counterEvidenceIdsJson: text("counter_evidence_ids_json").notNull(),
  confidence: text("confidence").notNull(), professorOverrideJson: text("professor_override_json"),
});
