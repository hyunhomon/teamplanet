CREATE TABLE `collection_coverage` (
	`request_id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`from_ms` integer NOT NULL,
	`to_ms` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`merged` integer DEFAULT 0 NOT NULL,
	`excluded` integer DEFAULT 0 NOT NULL,
	`tombstoned` integer DEFAULT 0 NOT NULL,
	`old_thread_roots` integer DEFAULT 0 NOT NULL,
	`limitations_json` text DEFAULT '[]' NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "collection_coverage_status" CHECK("collection_coverage"."status" IN ('running', 'complete', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `collection_coverage_team` ON `collection_coverage` (`team_id`,`from_ms`,`to_ms`);