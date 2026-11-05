CREATE TABLE `professor_finalizations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`professor_id` text NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`artifact_hash` text NOT NULL,
	`run_version` integer NOT NULL,
	`payload_json` text NOT NULL,
	`confirmed_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `professor_finalize_request` ON `professor_finalizations` (`professor_id`,`request_id`);
--> statement-breakpoint
CREATE TRIGGER professor_finalization_immutable BEFORE UPDATE ON professor_finalizations
BEGIN SELECT RAISE(ABORT, 'Professor finalization is immutable; create a new run'); END;
