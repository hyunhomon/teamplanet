/** D1 SQLite schema. Keep schema, SQL migrations and audit/reference triggers in sync. */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, sqliteTable, text, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core";

export const professors = sqliteTable("professors", {
  id: text("id").primaryKey(), email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, table => [check("professors_email_normalized", sql`${table.email} = lower(trim(${table.email}))`)]);
export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(), professorId: text("professor_id").notNull().references(() => professors.id),
  name: text("name").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  // #8 pilot settings: the approved consent form version (consent_policies) and the real course end time.
  startsAt: integer("starts_at", { mode: "timestamp_ms" }),
  consentVersion: text("consent_version"), endsAt: integer("ends_at", { mode: "timestamp_ms" }),
});

// #9: current course settings only. #16 must snapshot them into each new run.
export const courseRubricSettings = sqliteTable("course_rubric_settings", {
  courseId: text("course_id").primaryKey().references(() => courses.id),
  rubricVersion: text("rubric_version").notNull(),
  selectedCompetenciesJson: text("selected_competencies_json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [
  check("course_rubric_version", sql`${table.rubricVersion} = 'communication-v1'`),
  check("course_rubric_selection", sql`json_valid(${table.selectedCompetenciesJson}) AND json_type(${table.selectedCompetenciesJson}) = 'array' AND json_array_length(${table.selectedCompetenciesJson}) BETWEEN 1 AND 4`),
]);

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

/** Durable outbox and execution ledger: payloads contain references, never message bodies/tokens. */
export const queueJobs = sqliteTable("queue_jobs", {
  jobKey: text("job_key").primaryKey(), jobJson: text("job_json").notNull(),
  generation: integer("generation").notNull().default(0), status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0), dispatches: integer("dispatches").notNull().default(0),
  availableAt: integer("available_at").notNull().default(0), dispatchAt: integer("dispatch_at").notNull().default(0),
  leaseToken: text("lease_token"), leaseUntil: integer("lease_until"), errorCode: text("error_code"),
  deadLetteredAt: integer("dead_lettered_at"), dlqAttempts: integer("dlq_attempts").notNull().default(0),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
}, table => [
  check("queue_jobs_status", sql`${table.status} IN ('pending','running','retry','completed','dead')`),
  uniqueIndex("queue_jobs_dispatch_lookup").on(table.status, table.dispatchAt, table.jobKey),
]);
/** SQL trigger fences checkpoint + application writes against stale/expired leases. */
export const jobCheckpoints = sqliteTable("job_checkpoints", {
  jobKey: text("job_key").notNull().references(() => queueJobs.jobKey), name: text("name").notNull(),
  reference: text("reference").notNull(), generation: integer("generation").notNull(),
  leaseToken: text("lease_token").notNull(), recordedAt: integer("recorded_at").notNull(),
}, table => [primaryKey({ columns: [table.jobKey, table.name] })]);
export const jobFailures = sqliteTable("job_failures", {
  jobKey: text("job_key").notNull().references(() => queueJobs.jobKey), generation: integer("generation").notNull(),
  attempt: integer("attempt").notNull(), code: text("code").notNull(), retryable: integer("retryable", { mode: "boolean" }).notNull(),
  recordedAt: integer("recorded_at").notNull(),
}, table => [primaryKey({ columns: [table.jobKey, table.generation, table.attempt] })]);
export const jobRecoveries = sqliteTable("job_recoveries", {
  jobKey: text("job_key").notNull().references(() => queueJobs.jobKey), generation: integer("generation").notNull(),
  reasonRef: text("reason_ref").notNull(), recordedAt: integer("recorded_at").notNull(),
}, table => [primaryKey({ columns: [table.jobKey, table.generation] })]);
export const queueRejections = sqliteTable("queue_rejections", {
  messageId: text("message_id").primaryKey(), code: text("code").notNull(), recordedAt: integer("recorded_at").notNull(),
});

/** Professor OTP login (#2). Only SHA-256 hashes of codes and session tokens are stored. */
export const authChallenges = sqliteTable("auth_challenges", {
  id: text("id").primaryKey(), email: text("email").notNull(),
  // NULL for unregistered emails: the row exists only so responses and rate limits look identical.
  professorId: text("professor_id").references(() => professors.id),
  codeHash: text("code_hash").notNull(), attempts: integer("attempts").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
}, table => [index("auth_challenges_email_created").on(table.email, table.createdAt)]);
export const authSessions = sqliteTable("auth_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  professorId: text("professor_id").notNull().references(() => professors.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
});

/**
 * Minimal audit trail (#3): who did what to which ID, when, and the outcome.
 * Columns hold only typed IDs and enums; there is no place for message bodies, OTPs or tokens.
 */
export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorProfessorId: text("actor_professor_id").notNull().references(() => professors.id),
  action: text("action").notNull(), targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(), result: text("result").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
}, table => [
  check("audit_events_action", sql`${table.action} GLOB '[a-z]*.[a-z]*' AND length(${table.action}) <= 64`),
  check("audit_events_target", sql`${table.targetType} GLOB '[a-z]*' AND length(${table.targetType}) <= 32 AND length(${table.targetId}) BETWEEN 1 AND 100`),
  check("audit_events_result", sql`${table.result} IN ('succeeded', 'denied')`),
  index("audit_events_target_lookup").on(table.targetType, table.targetId, table.recordedAt),
]);

/** Slack OAuth state (#6): only the hash is stored; single use, short TTL, bound to the session that started the install. */
export const slackOauthStates = sqliteTable("slack_oauth_states", {
  stateHash: text("state_hash").primaryKey(),
  sessionHash: text("session_hash").notNull(),
  professorId: text("professor_id").notNull().references(() => professors.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
});
/** Bot installation for the single pilot workspace (#6). The bot token is AES-GCM sealed with the SLACK_TOKEN_KEY secret and cleared on revoke. */
export const slackInstallations = sqliteTable("slack_installations", {
  workspaceId: text("workspace_id").primaryKey().references(() => workspaces.id),
  teamName: text("team_name").notNull(), appId: text("app_id").notNull(), botUserId: text("bot_user_id").notNull(),
  scopes: text("scopes").notNull(), tokenCiphertext: text("token_ciphertext"),
  installedBySlackUserId: text("installed_by_slack_user_id").notNull(),
  installedByProfessorId: text("installed_by_professor_id").notNull().references(() => professors.id),
  installedAt: integer("installed_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, table => [check("slack_installations_token_state", sql`(${table.tokenCiphertext} IS NULL) = (${table.revokedAt} IS NOT NULL)`)]);

/**
 * Consent gate (#8). Operator-approved consent form versions; rows are added only by the operator (D1), never by an API.
 * A row means the form and its notice (including model transmission, ADR-0003) were confirmed for the pilot.
 */
export const consentPolicies = sqliteTable("consent_policies", {
  version: text("version").primaryKey(),
  noticeConfirmedAt: integer("notice_confirmed_at", { mode: "timestamp_ms" }).notNull(),
  approvedBy: text("approved_by").notNull(),
});
/** Who recorded each consent_history row and the opaque paper-form reference. consent_history itself stays trigger-written. */
export const consentEvidence = sqliteTable("consent_evidence", {
  historyId: integer("history_id").primaryKey().references(() => consentHistory.id),
  actorProfessorId: text("actor_professor_id").notNull().references(() => professors.id),
  evidenceRef: text("evidence_ref"),
});
/** Student QR re-confirmation. Only the token hash is stored; a confirmation counts only for the grant it was issued after. */
export const consentConfirmations = sqliteTable("consent_confirmations", {
  tokenHash: text("token_hash").primaryKey(),
  teamId: text("team_id").notNull(), studentId: text("student_id").notNull(), version: text("version").notNull(),
  issuedByProfessorId: text("issued_by_professor_id").notNull().references(() => professors.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
  // The exact grant (consent_history row) the link was issued for; a later change of any kind, even at the same ms, voids it.
  consentHistoryId: integer("consent_history_id").references(() => consentHistory.id),
}, table => [index("consent_confirmations_student").on(table.teamId, table.studentId)]);
/** Allowed collection intervals. Exactly one open window while a team is active; closed windows keep the past intervals. */
export const collectionWindows = sqliteTable("collection_windows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: text("team_id").notNull().references(() => teams.id),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  endReason: text("end_reason"),
}, table => [
  uniqueIndex("collection_windows_one_open").on(table.teamId).where(sql`${table.endedAt} IS NULL`),
  index("collection_windows_team").on(table.teamId, table.startedAt),
  check("collection_windows_end", sql`(${table.endedAt} IS NULL AND ${table.endReason} IS NULL) OR (${table.endedAt} >= ${table.startedAt} AND ${table.endReason} IN ('professor', 'consent_changed', 'policy_changed', 'unknown_participant', 'member_left', 'bot_removed', 'slack_revoked', 'course_ended'))`),
]);

/**
 * Slack Events intake ledger (#11): dedupe by event_id plus processing outcome. Metadata only — never text or payloads.
 * Ignored events keep no channel/user/ts so DMs and out-of-scope traffic leave nothing but the id and the reason.
 */
export const slackEventRefs = sqliteTable("slack_event_refs", {
  eventRef: text("event_ref").primaryKey(), workspaceId: text("workspace_id").notNull(), eventId: text("event_id").notNull().unique(),
  kind: text("kind").notNull(), teamId: text("team_id"), channelId: text("channel_id"), slackTs: text("slack_ts"),
  threadTs: text("thread_ts"), userId: text("user_id"), revision: text("revision"), contentHash: text("content_hash"),
  outcome: text("outcome").notNull(), receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }),
}, table => [
  check("slack_event_refs_kind", sql`${table.kind} IN ('message', 'message_changed', 'message_deleted', 'member_joined', 'member_left', 'revoked', 'ignored')`),
  index("slack_event_refs_outcome").on(table.outcome, table.receivedAt),
]);
/**
 * Message references (#11/#12): Slack stays the source of text. One row per channel + Slack ts, with the latest
 * revision, a SHA-256 content fingerprint and a tombstone that later creates/edits can never undo.
 */
export const messageRefs = sqliteTable("message_refs", {
  channelId: text("channel_id").notNull(), slackTs: text("slack_ts").notNull(),
  teamId: text("team_id").notNull().references(() => teams.id), userId: text("user_id"), threadTs: text("thread_ts"),
  revision: text("revision").notNull(), contentHash: text("content_hash"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }), source: text("source").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
}, table => [
  primaryKey({ columns: [table.channelId, table.slackTs] }),
  index("message_refs_team_ts").on(table.teamId, table.slackTs),
  index("message_refs_thread").on(table.channelId, table.threadTs),
  check("message_refs_source", sql`${table.source} IN ('event', 'history')`),
  check("message_refs_tombstone", sql`${table.deletedAt} IS NULL OR ${table.contentHash} IS NULL`),
]);

/**
 * History/Replies recovery coverage (#12), read by analysis (#16). One row per recovery request for a team's [from, to).
 * `complete` only when every allowed interval was fully paged; limitations name what was outside or excluded.
 */
export const collectionCoverage = sqliteTable("collection_coverage", {
  requestId: text("request_id").primaryKey(), teamId: text("team_id").notNull().references(() => teams.id),
  fromMs: integer("from_ms").notNull(), toMs: integer("to_ms").notNull(),
  status: text("status").notNull(), reason: text("reason"),
  merged: integer("merged").notNull().default(0), excluded: integer("excluded").notNull().default(0),
  tombstoned: integer("tombstoned").notNull().default(0), oldThreadRoots: integer("old_thread_roots").notNull().default(0),
  limitationsJson: text("limitations_json").notNull().default("[]"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [
  index("collection_coverage_team").on(table.teamId, table.fromMs, table.toMs),
  check("collection_coverage_status", sql`${table.status} IN ('running', 'complete', 'partial', 'failed')`),
]);

/** Attachment metadata only: no URLs, tokens, image bytes or permanent image cache. */
export const imageRefs = sqliteTable("image_refs", {
  teamId: text("team_id").notNull().references(() => teams.id), channelId: text("channel_id").notNull(), slackTs: text("slack_ts").notNull(),
  fileId: text("file_id").notNull(), sourceRevision: text("source_revision").notNull(), fileRevision: text("file_revision"),
  contentHash: text("content_hash"), limitation: text("limitation"), verifiedAt: integer("verified_at").notNull(),
}, table => [primaryKey({ columns: [table.channelId, table.slackTs, table.fileId] }),
  foreignKey({ columns: [table.channelId, table.slackTs], foreignColumns: [messageRefs.channelId, messageRefs.slackTs] })]);

export const teamDataVersions = sqliteTable("team_data_versions", {
  teamId: text("team_id").primaryKey().references(() => teams.id), epoch: integer("epoch").notNull().default(0),
  blockedAt: integer("blocked_at"), purgedAt: integer("purged_at"), reason: text("reason"), updatedAt: integer("updated_at").notNull(),
});
/** A run without this row is unverified legacy data, never implicitly valid. */
export const runDataValidity = sqliteTable("run_data_validity", {
  runId: text("run_id").primaryKey().references(() => analysisRuns.id), teamId: text("team_id").notNull().references(() => teams.id),
  dataEpoch: integer("data_epoch").notNull(), invalidatedAt: integer("invalidated_at"), reason: text("reason"),
});
export const dataInvalidations = sqliteTable("data_invalidations", {
  id: integer("id").primaryKey({ autoIncrement: true }), teamId: text("team_id").notNull(),
  epoch: integer("epoch").notNull(), reason: text("reason").notNull(), recordedAt: integer("recorded_at").notNull(),
});
export const dataErasureJobs = sqliteTable("data_erasure_jobs", {
  id: text("id").primaryKey(), teamId: text("team_id").notNull().unique().references(() => teams.id),
  reason: text("reason").notNull(), status: text("status").notNull().default("pending"), attempts: integer("attempts").notNull().default(0),
  requestedAt: integer("requested_at").notNull(), completedAt: integer("completed_at"), nextAttemptAt: integer("next_attempt_at").notNull().default(0), errorCode: text("error_code"),
}, t => [check("data_erasure_status", sql`${t.status} IN ('pending','processing','completed','failed')`)]);

export const inquirySettings = sqliteTable("inquiry_settings", {
  courseId: text("course_id").primaryKey().references(() => courses.id), days: integer("days").notNull(),
  updatedAt: integer("updated_at").notNull(), lastCleanupAt: integer("last_cleanup_at"), cleanupError: text("cleanup_error"),
}, t => [check("inquiry_positive_days", sql`${t.days} > 0`)]);
export const inquiries = sqliteTable("inquiries", {
  id: text("id").primaryKey(), courseId: text("course_id").notNull().references(() => courses.id),
  teamId: text("team_id").notNull().references(() => teams.id), studentId: text("student_id").notNull().references(() => students.id),
  identityHash: text("identity_hash").notNull(), body: text("body").notNull(), answer: text("answer"),
  receivedAt: integer("received_at").notNull(), days: integer("days").notNull(), expiresAt: integer("expires_at").notNull(), answeredAt: integer("answered_at"),
}, t => [index("inquiries_expiry").on(t.expiresAt)]);
/** Short-lived single-use submission capability. Deleting it cannot recreate a received inquiry. */
export const inquiryTickets = sqliteTable("inquiry_tickets", {
  hash: text("hash").primaryKey(), identityHash: text("identity_hash").notNull(), courseId: text("course_id").notNull(),
  teamId: text("team_id").notNull(), studentId: text("student_id").notNull(), days: integer("days").notNull(),
  validUntil: integer("valid_until").notNull(), inquiryId: text("inquiry_id"),
});
/** Body-free actual withdrawal/correction record, independent of inquiry expiry. */
export const inquiryEffects = sqliteTable("inquiry_effects", {
  inquiryId: text("inquiry_id").notNull(), teamId: text("team_id").notNull(), studentId: text("student_id").notNull(),
  kind: text("kind").notNull(), processedAt: integer("processed_at").notNull(),
}, t => [primaryKey({ columns: [t.inquiryId, t.kind] })]);

export const analysisSpecs = sqliteTable("analysis_specs", {
  runId: text("run_id").primaryKey().references(() => analysisRuns.id), teamId: text("team_id").notNull(),
  professorId: text("professor_id").notNull(), idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(),
  version: integer("version").notNull(), timezone: text("timezone").notNull(), createdAt: integer("created_at").notNull(),
  snapshotJson: text("snapshot_json").notNull(), studentsJson: text("students_json").notNull(), manifestJson: text("manifest_json"),
}, t => [uniqueIndex("analysis_idempotency").on(t.professorId, t.idempotencyKey), uniqueIndex("analysis_version").on(t.teamId, t.version)]);
export const analysisSources = sqliteTable("analysis_sources", {
  runId: text("run_id").notNull().references(() => analysisRuns.id), id: text("id").notNull(),
  channelId: text("channel_id").notNull(), slackTs: text("slack_ts").notNull(), refJson: text("ref_json").notNull(),
  studentId: text("student_id").notNull(), textLength: integer("text_length").notNull(), partsJson: text("parts_json").notNull(), attachmentsJson: text("attachments_json").notNull(),
}, t => [primaryKey({ columns: [t.runId, t.id] }), uniqueIndex("analysis_source_ref").on(t.runId, t.channelId, t.slackTs)]);
export const analysisChunks = sqliteTable("analysis_chunks", {
  runId: text("run_id").notNull().references(() => analysisRuns.id), id: text("id").notNull(), ordinal: integer("ordinal").notNull(), planJson: text("plan_json").notNull(),
}, t => [primaryKey({ columns: [t.runId, t.id] })]);
/** Outputs contain summaries and citation hashes, never quotes/raw source or image bytes. */
export const analysisStageResults = sqliteTable("analysis_stage_results", {
  runId: text("run_id").notNull().references(() => analysisRuns.id), stage: text("stage").notNull(), chunkId: text("chunk_id").notNull(),
  iteration: integer("iteration").notNull(), outputJson: text("output_json").notNull(), modelId: text("model_id").notNull(), provider: text("provider").notNull(),
  promptVersion: text("prompt_version").notNull(), completedAt: integer("completed_at").notNull(),
}, t => [primaryKey({ columns: [t.runId, t.stage, t.chunkId, t.iteration] })]);
