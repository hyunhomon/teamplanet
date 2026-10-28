CREATE TABLE `slack_installations` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`team_name` text NOT NULL,
	`app_id` text NOT NULL,
	`bot_user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`token_ciphertext` text,
	`installed_by_slack_user_id` text NOT NULL,
	`installed_by_professor_id` text NOT NULL,
	`installed_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`installed_by_professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "slack_installations_token_state" CHECK(("slack_installations"."token_ciphertext" IS NULL) = ("slack_installations"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `slack_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`session_hash` text NOT NULL,
	`professor_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);
