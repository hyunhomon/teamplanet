CREATE TABLE `analysis_chunks` (
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`plan_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`),
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `analysis_sources` (
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`channel_id` text NOT NULL,
	`slack_ts` text NOT NULL,
	`ref_json` text NOT NULL,
	`student_id` text NOT NULL,
	`text_length` integer NOT NULL,
	`parts_json` text NOT NULL,
	`attachments_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`),
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_source_ref` ON `analysis_sources` (`run_id`,`channel_id`,`slack_ts`);--> statement-breakpoint
CREATE TABLE `analysis_specs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`professor_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`version` integer NOT NULL,
	`timezone` text NOT NULL,
	`created_at` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`students_json` text NOT NULL,
	`manifest_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_idempotency` ON `analysis_specs` (`professor_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_version` ON `analysis_specs` (`team_id`,`version`);--> statement-breakpoint
CREATE TABLE `analysis_stage_results` (
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`chunk_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`output_json` text NOT NULL,
	`model_id` text NOT NULL,
	`provider` text NOT NULL,
	`prompt_version` text NOT NULL,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `stage`, `chunk_id`, `iteration`),
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action
);
