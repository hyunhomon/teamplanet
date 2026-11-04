CREATE TABLE `analysis_calls` (
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`chunk_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`generation_id` text,
	`output_json` text,
	`error_code` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `stage`, `chunk_id`, `iteration`),
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "analysis_call_status" CHECK("analysis_calls"."status" IN ('started','response','verified','failed','uncertain')),
	CONSTRAINT "analysis_call_attempt" CHECK("analysis_calls"."attempt" > 0)
);
--> statement-breakpoint
CREATE TABLE `analysis_outputs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`output_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action
);
