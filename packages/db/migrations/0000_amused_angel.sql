CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`from_ts` text NOT NULL,
	`to_ts` text NOT NULL,
	`status` text NOT NULL,
	`stage_metadata_json` text,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`student_id` text NOT NULL,
	`competency_key` text NOT NULL,
	`judgement` text NOT NULL,
	`narrative` text NOT NULL,
	`evidence_ids_json` text NOT NULL,
	`counter_evidence_ids_json` text NOT NULL,
	`limitations_json` text NOT NULL,
	`requires_human_review` integer NOT NULL,
	`confidence` text NOT NULL,
	`professor_override_json` text
);
--> statement-breakpoint
CREATE TABLE `consent_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`status` text NOT NULL,
	`version` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `consents` (
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`status` text NOT NULL,
	`version` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `student_id`)
);
--> statement-breakpoint
CREATE TABLE `evidence_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`message_ids_json` text NOT NULL,
	`actor_ids_json` text NOT NULL,
	`summary` text NOT NULL,
	`tags_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`slack_channel_id` text NOT NULL,
	`slack_ts` text NOT NULL,
	`user_id` text,
	`thread_ts` text,
	`text` text,
	`attachment_refs_json` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`name` text NOT NULL,
	`collection_status` text DEFAULT 'inactive' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slack_team_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slack_team_id_unique` ON `workspaces` (`slack_team_id`);