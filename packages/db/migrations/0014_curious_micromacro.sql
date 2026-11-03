CREATE TABLE `inquiries` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`identity_hash` text NOT NULL,
	`body` text NOT NULL,
	`answer` text,
	`received_at` integer NOT NULL,
	`days` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `students`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inquiries_expiry` ON `inquiries` (`expires_at`);--> statement-breakpoint
CREATE TABLE `inquiry_effects` (
	`inquiry_id` text NOT NULL,
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`kind` text NOT NULL,
	`processed_at` integer NOT NULL,
	PRIMARY KEY(`inquiry_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `inquiry_settings` (
	`course_id` text PRIMARY KEY NOT NULL,
	`days` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_cleanup_at` integer,
	`cleanup_error` text,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inquiry_positive_days" CHECK("inquiry_settings"."days" > 0)
);
--> statement-breakpoint
CREATE TABLE `inquiry_tickets` (
	`hash` text PRIMARY KEY NOT NULL,
	`identity_hash` text NOT NULL,
	`course_id` text NOT NULL,
	`team_id` text NOT NULL,
	`student_id` text NOT NULL,
	`days` integer NOT NULL,
	`valid_until` integer NOT NULL,
	`inquiry_id` text
);
--> statement-breakpoint
CREATE TRIGGER inquiry_receipt_immutable BEFORE UPDATE OF received_at, days, expires_at, identity_hash, student_id, team_id, course_id ON inquiries
WHEN NEW.received_at IS NOT OLD.received_at OR NEW.days IS NOT OLD.days OR NEW.expires_at IS NOT OLD.expires_at
 OR NEW.identity_hash IS NOT OLD.identity_hash OR NEW.student_id IS NOT OLD.student_id OR NEW.team_id IS NOT OLD.team_id OR NEW.course_id IS NOT OLD.course_id
BEGIN SELECT RAISE(ABORT, 'inquiry_receipt_immutable'); END;
