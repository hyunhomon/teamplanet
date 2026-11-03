CREATE TABLE `data_erasure_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`requested_at` integer NOT NULL,
	`completed_at` integer,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "data_erasure_status" CHECK("data_erasure_jobs"."status" IN ('pending','processing','completed','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_erasure_jobs_team_id_unique` ON `data_erasure_jobs` (`team_id`);--> statement-breakpoint
CREATE TABLE `data_invalidations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`reason` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_data_validity` (
	`run_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`data_epoch` integer NOT NULL,
	`invalidated_at` integer,
	`reason` text,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `team_data_versions` (
	`team_id` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`blocked_at` integer,
	`purged_at` integer,
	`reason` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
INSERT INTO team_data_versions (team_id, updated_at) SELECT id, 0 FROM teams;
--> statement-breakpoint
CREATE TRIGGER team_data_init AFTER INSERT ON teams BEGIN INSERT INTO team_data_versions (team_id, updated_at) VALUES (NEW.id, 0); END;
--> statement-breakpoint
CREATE TRIGGER team_data_invalidated AFTER UPDATE OF epoch ON team_data_versions WHEN NEW.epoch <> OLD.epoch BEGIN
 UPDATE run_data_validity SET invalidated_at = COALESCE(invalidated_at, NEW.updated_at), reason = COALESCE(reason, NEW.reason) WHERE team_id = NEW.team_id;
 INSERT INTO data_invalidations (team_id, epoch, reason, recorded_at) VALUES (NEW.team_id, NEW.epoch, COALESCE(NEW.reason,'source_changed'), NEW.updated_at);
 UPDATE queue_jobs SET status = 'dead', error_code = 'DATA_INVALIDATED', lease_token = NULL, lease_until = NULL, updated_at = NEW.updated_at
 WHERE status IN ('pending','retry','running') AND json_extract(job_json,'$.kind') = 'analysis.stage'
 AND json_extract(job_json,'$.runId') IN (SELECT id FROM analysis_runs WHERE team_id = NEW.team_id);
END;
--> statement-breakpoint
CREATE TRIGGER message_data_insert AFTER INSERT ON message_refs BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'source_changed', updated_at = NEW.updated_at WHERE team_id = NEW.team_id;
 
 END;
--> statement-breakpoint
CREATE TRIGGER image_data_insert AFTER INSERT ON image_refs BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'image_changed', updated_at = NEW.verified_at WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER consent_data_insert AFTER INSERT ON consents BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'consent_changed', updated_at = NEW.recorded_at WHERE team_id = NEW.team_id;
 
 END;
--> statement-breakpoint
CREATE TRIGGER message_data_update AFTER UPDATE ON message_refs WHEN NEW.revision IS NOT OLD.revision OR NEW.content_hash IS NOT OLD.content_hash OR NEW.deleted_at IS NOT OLD.deleted_at OR NEW.user_id IS NOT OLD.user_id BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'source_changed', updated_at = NEW.updated_at WHERE team_id = NEW.team_id;
 UPDATE image_refs SET content_hash = NULL, limitation = 'source_invalidated' WHERE channel_id = NEW.channel_id AND slack_ts = NEW.slack_ts AND (content_hash IS NOT NULL OR limitation IS NOT 'source_invalidated');
 END;
--> statement-breakpoint
CREATE TRIGGER image_data_update AFTER UPDATE ON image_refs WHEN NEW.source_revision IS NOT OLD.source_revision OR NEW.file_revision IS NOT OLD.file_revision OR NEW.content_hash IS NOT OLD.content_hash OR NEW.limitation IS NOT OLD.limitation BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'image_changed', updated_at = NEW.verified_at WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER consent_data_update AFTER UPDATE ON consents BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'consent_changed', updated_at = NEW.recorded_at WHERE team_id = NEW.team_id;
 UPDATE message_refs SET content_hash = NULL, user_id = NULL, thread_ts = NULL, deleted_at = COALESCE(deleted_at, NEW.recorded_at), updated_at = NEW.recorded_at
 WHERE team_id = NEW.team_id AND user_id IN (SELECT slack_user_id FROM student_slack_mappings WHERE student_id = NEW.student_id)
 AND NEW.status <> 'granted';
 END;
--> statement-breakpoint
CREATE TRIGGER message_data_delete AFTER DELETE ON message_refs BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'source_changed', updated_at = OLD.updated_at WHERE team_id = OLD.team_id;
 
 END;
--> statement-breakpoint
CREATE TRIGGER image_data_delete AFTER DELETE ON image_refs BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'image_changed', updated_at = OLD.verified_at WHERE team_id = OLD.team_id; END;
--> statement-breakpoint
CREATE TRIGGER consent_data_delete AFTER DELETE ON consents BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'consent_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = OLD.team_id;
 UPDATE message_refs SET content_hash = NULL, user_id = NULL, thread_ts = NULL, deleted_at = COALESCE(deleted_at, CAST(unixepoch('subsec') * 1000 AS INTEGER)), updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE team_id = OLD.team_id AND user_id IN (SELECT slack_user_id FROM student_slack_mappings WHERE student_id = OLD.student_id)
 ;
 END;
--> statement-breakpoint
CREATE TRIGGER confirmation_data_update AFTER UPDATE OF confirmed_at, consent_history_id ON consent_confirmations
WHEN NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.consent_history_id IS NOT OLD.consent_history_id BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'consent_changed', updated_at = COALESCE(NEW.confirmed_at,NEW.created_at) WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER course_data_update AFTER UPDATE OF consent_version, starts_at, ends_at ON courses
WHEN NEW.consent_version IS NOT OLD.consent_version OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'course_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE team_id IN (SELECT id FROM teams WHERE course_id = NEW.id); END;
--> statement-breakpoint
CREATE TRIGGER team_members_data_insert AFTER INSERT ON team_members BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER team_members_data_update AFTER UPDATE ON team_members BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER team_members_data_delete AFTER DELETE ON team_members BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = OLD.team_id; END;
--> statement-breakpoint
CREATE TRIGGER collection_windows_data_insert AFTER INSERT ON collection_windows BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER collection_windows_data_update AFTER UPDATE ON collection_windows BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = NEW.team_id; END;
--> statement-breakpoint
CREATE TRIGGER collection_windows_data_delete AFTER DELETE ON collection_windows BEGIN UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = OLD.team_id; END;
--> statement-breakpoint
CREATE TRIGGER mapping_data_update AFTER UPDATE ON student_slack_mappings BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'mapping_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE team_id IN (SELECT team_id FROM team_members WHERE student_id IN (OLD.student_id,NEW.student_id)); END;
--> statement-breakpoint
CREATE TRIGGER installation_data_update AFTER UPDATE OF token_ciphertext, revoked_at ON slack_installations BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'slack_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE team_id IN (SELECT id FROM teams WHERE workspace_id = NEW.workspace_id); END;
--> statement-breakpoint
CREATE TRIGGER mapping_data_delete AFTER DELETE ON student_slack_mappings BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'mapping_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE team_id IN (SELECT team_id FROM team_members WHERE student_id = OLD.student_id); END;
--> statement-breakpoint
CREATE TRIGGER confirmation_data_delete AFTER DELETE ON consent_confirmations BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'consent_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = OLD.team_id; END;
--> statement-breakpoint
CREATE TRIGGER team_scope_data_update AFTER UPDATE OF course_id, workspace_id, channel_id ON teams BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'scope_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE team_id = NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER installation_data_delete AFTER DELETE ON slack_installations BEGIN
 UPDATE team_data_versions SET epoch = epoch + 1, reason = 'slack_changed', updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE team_id IN (SELECT id FROM teams WHERE workspace_id = OLD.workspace_id); END;
