CREATE TABLE `image_refs` (
	`team_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`slack_ts` text NOT NULL,
	`file_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`file_revision` text,
	`content_hash` text,
	`limitation` text,
	`verified_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `slack_ts`, `file_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`,`slack_ts`) REFERENCES `message_refs`(`channel_id`,`slack_ts`) ON UPDATE no action ON DELETE no action
);
