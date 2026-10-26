CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`professor_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `professors` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "professors_email_normalized" CHECK("professors"."email" = lower(trim("professors"."email")))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `professors_email_unique` ON `professors` (`email`);--> statement-breakpoint
CREATE TABLE `slack_users` (
	`workspace_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `slack_user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `student_slack_mappings` (
	`student_id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	FOREIGN KEY (`student_id`,`course_id`) REFERENCES `students`(`id`,`course_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`,`slack_user_id`) REFERENCES `slack_users`(`workspace_id`,`slack_user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `student_slack_course_user_unique` ON `student_slack_mappings` (`course_id`,`workspace_id`,`slack_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `student_slack_membership_scope_unique` ON `student_slack_mappings` (`student_id`,`course_id`,`workspace_id`);--> statement-breakpoint
CREATE TABLE `students` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_course_scope_unique` ON `students` (`id`,`course_id`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`course_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	PRIMARY KEY(`team_id`, `student_id`),
	FOREIGN KEY (`team_id`,`course_id`,`workspace_id`) REFERENCES `teams`(`id`,`course_id`,`workspace_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`,`course_id`,`workspace_id`) REFERENCES `student_slack_mappings`(`student_id`,`course_id`,`workspace_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `teams` ADD `course_id` text REFERENCES courses(id);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_workspace_channel_unique` ON `teams` (`workspace_id`,`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_workspace_name_unique` ON `teams` (`workspace_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_membership_scope_unique` ON `teams` (`id`,`course_id`,`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_single_pilot` ON `workspaces` ((1));
--> statement-breakpoint
-- Additive upgrade: existing teams have NULL course_id and remain quarantined.
-- Do not invent an owner, rewrite evaluation rows, or rebuild consents/history.
-- Workspace FK behavior uses triggers so legacy teams need not be rebuilt.
CREATE TRIGGER teams_scope_insert
BEFORE INSERT ON teams
WHEN NEW.course_id IS NULL OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'team requires a course and existing workspace');
END;
--> statement-breakpoint
CREATE TRIGGER teams_scope_update
BEFORE UPDATE OF course_id, workspace_id ON teams
WHEN (OLD.course_id IS NOT NULL AND NEW.course_id IS NULL)
  OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'team ownership cannot be cleared; workspace must exist');
END;
--> statement-breakpoint
CREATE TRIGGER workspaces_teams_delete
BEFORE DELETE ON workspaces
WHEN EXISTS (SELECT 1 FROM teams WHERE workspace_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'workspace is referenced by teams');
END;
--> statement-breakpoint
CREATE TRIGGER workspaces_teams_update
BEFORE UPDATE OF id ON workspaces
WHEN NEW.id != OLD.id AND EXISTS (SELECT 1 FROM teams WHERE workspace_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'workspace is referenced by teams');
END;
