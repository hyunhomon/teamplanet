CREATE TABLE `course_rubric_settings` (
	`course_id` text PRIMARY KEY NOT NULL,
	`rubric_version` text NOT NULL,
	`selected_competencies_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "course_rubric_version" CHECK("course_rubric_settings"."rubric_version" = 'communication-v1'),
	CONSTRAINT "course_rubric_selection" CHECK(json_valid("course_rubric_settings"."selected_competencies_json") AND json_type("course_rubric_settings"."selected_competencies_json") = 'array' AND json_array_length("course_rubric_settings"."selected_competencies_json") BETWEEN 1 AND 4)
);
--> statement-breakpoint
ALTER TABLE `courses` ADD `starts_at` integer;