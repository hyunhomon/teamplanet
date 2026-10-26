/** D1 SQLite schema. Keep schema, SQL migrations and audit/reference triggers in sync. */
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const professors = sqliteTable("professors", {
  id: text("id").primaryKey(), email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, table => [check("professors_email_normalized", sql`${table.email} = lower(trim(${table.email}))`)]);
export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(), professorId: text("professor_id").notNull().references(() => professors.id),
  name: text("name").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(), slackTeamId: text("slack_team_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, () => [uniqueIndex("workspaces_single_pilot").on(sql`(1)`)]);
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(), workspaceId: text("workspace_id").notNull(),
  // Nullable only for pre-contract rows: never infer a professor for legacy data.
  // Migration triggers require a course on new rows and validate workspace references.
  courseId: text("course_id").references(() => courses.id),
  channelId: text("channel_id").notNull(), name: text("name").notNull(),
  collectionStatus: text("collection_status").notNull().default("inactive"),
}, table => [
  uniqueIndex("teams_workspace_channel_unique").on(table.workspaceId, table.channelId),
  uniqueIndex("teams_workspace_name_unique").on(table.workspaceId, table.name),
  uniqueIndex("teams_membership_scope_unique").on(table.id, table.courseId, table.workspaceId),
]);
export const students = sqliteTable("students", {
  id: text("id").primaryKey(), courseId: text("course_id").notNull().references(() => courses.id),
  displayName: text("display_name").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, table => [uniqueIndex("students_course_scope_unique").on(table.id, table.courseId)]);
export const slackUsers = sqliteTable("slack_users", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  slackUserId: text("slack_user_id").notNull(),
}, table => [primaryKey({ columns: [table.workspaceId, table.slackUserId] })]);
export const studentSlackMappings = sqliteTable("student_slack_mappings", {
  studentId: text("student_id").primaryKey(), courseId: text("course_id").notNull(),
  workspaceId: text("workspace_id").notNull(), slackUserId: text("slack_user_id").notNull(),
}, table => [
  foreignKey({ columns: [table.studentId, table.courseId], foreignColumns: [students.id, students.courseId] }),
  foreignKey({ columns: [table.workspaceId, table.slackUserId], foreignColumns: [slackUsers.workspaceId, slackUsers.slackUserId] }),
  uniqueIndex("student_slack_course_user_unique").on(table.courseId, table.workspaceId, table.slackUserId),
  uniqueIndex("student_slack_membership_scope_unique").on(table.studentId, table.courseId, table.workspaceId),
]);
export const teamMembers = sqliteTable("team_members", {
  teamId: text("team_id").notNull(), studentId: text("student_id").notNull(),
  courseId: text("course_id").notNull(), workspaceId: text("workspace_id").notNull(),
}, table => [
  primaryKey({ columns: [table.teamId, table.studentId] }),
  foreignKey({ columns: [table.teamId, table.courseId, table.workspaceId], foreignColumns: [teams.id, teams.courseId, teams.workspaceId] }),
  foreignKey({ columns: [table.studentId, table.courseId, table.workspaceId], foreignColumns: [studentSlackMappings.studentId, studentSlackMappings.courseId, studentSlackMappings.workspaceId] }),
]);
export const consents = sqliteTable("consents", {
  teamId: text("team_id").notNull(), studentId: text("student_id").notNull(),
  status: text("status").notNull(), version: text("version").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
}, table => [primaryKey({ columns: [table.teamId, table.studentId] })]);
/** Written by migration triggers; consents remains the current-state snapshot. */
export const consentHistory = sqliteTable("consent_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: text("team_id").notNull(), studentId: text("student_id").notNull(),
  status: text("status").notNull(), version: text("version").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
});
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
  limitationsJson: text("limitations_json").notNull(),
  requiresHumanReview: integer("requires_human_review", { mode: "boolean" }).notNull(),
  confidence: text("confidence").notNull(), professorOverrideJson: text("professor_override_json"),
});
