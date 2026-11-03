CREATE TABLE `message_refs` (
	`channel_id` text NOT NULL,
	`slack_ts` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text,
	`thread_ts` text,
	`revision` text NOT NULL,
	`content_hash` text,
	`deleted_at` integer,
	`source` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`verified_at` integer,
	PRIMARY KEY(`channel_id`, `slack_ts`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_refs_source" CHECK("message_refs"."source" IN ('event', 'history')),
	CONSTRAINT "message_refs_tombstone" CHECK("message_refs"."deleted_at" IS NULL OR "message_refs"."content_hash" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `message_refs_team_ts` ON `message_refs` (`team_id`,`slack_ts`);--> statement-breakpoint
CREATE INDEX `message_refs_thread` ON `message_refs` (`channel_id`,`thread_ts`);--> statement-breakpoint
CREATE TABLE `slack_event_refs` (
	`event_ref` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`team_id` text,
	`channel_id` text,
	`slack_ts` text,
	`thread_ts` text,
	`user_id` text,
	`revision` text,
	`content_hash` text,
	`outcome` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer,
	CONSTRAINT "slack_event_refs_kind" CHECK("slack_event_refs"."kind" IN ('message', 'message_changed', 'message_deleted', 'member_joined', 'member_left', 'revoked', 'ignored'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_event_refs_event_id_unique` ON `slack_event_refs` (`event_id`);--> statement-breakpoint
CREATE INDEX `slack_event_refs_outcome` ON `slack_event_refs` (`outcome`,`received_at`);