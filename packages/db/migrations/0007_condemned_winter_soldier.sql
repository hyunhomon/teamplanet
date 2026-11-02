CREATE TABLE `collection_windows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collection_windows_end" CHECK(("collection_windows"."ended_at" IS NULL AND "collection_windows"."end_reason" IS NULL) OR ("collection_windows"."ended_at" >= "collection_windows"."started_at" AND "collection_windows"."end_reason" IN ('professor', 'consent_changed', 'policy_changed', 'unknown_participant', 'member_left', 'bot_removed', 'slack_revoked', 'course_ended')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_windows_one_open` ON `collection_windows` (`team_id`) WHERE "collection_windows"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `collection_windows_team` ON `collection_windows` (`team_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `consent_confirmations` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`version` text NOT NULL,
	`issued_by_professor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`issued_by_professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `consent_confirmations_student` ON `consent_confirmations` (`team_id`,`student_id`);--> statement-breakpoint
CREATE TABLE `consent_evidence` (
	`history_id` integer PRIMARY KEY NOT NULL,
	`actor_professor_id` text NOT NULL,
	`evidence_ref` text,
	FOREIGN KEY (`history_id`) REFERENCES `consent_history`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `consent_policies` (
	`version` text PRIMARY KEY NOT NULL,
	`notice_confirmed_at` integer NOT NULL,
	`approved_by` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `courses` ADD `consent_version` text;--> statement-breakpoint
ALTER TABLE `courses` ADD `ends_at` integer;