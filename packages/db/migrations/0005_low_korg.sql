CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_professor_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`result` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`actor_professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_events_action" CHECK("audit_events"."action" GLOB '[a-z]*.[a-z]*' AND length("audit_events"."action") <= 64),
	CONSTRAINT "audit_events_target" CHECK("audit_events"."target_type" GLOB '[a-z]*' AND length("audit_events"."target_type") <= 32 AND length("audit_events"."target_id") BETWEEN 1 AND 100),
	CONSTRAINT "audit_events_result" CHECK("audit_events"."result" IN ('succeeded', 'denied'))
);
--> statement-breakpoint
CREATE INDEX `audit_events_target_lookup` ON `audit_events` (`target_type`,`target_id`,`recorded_at`);