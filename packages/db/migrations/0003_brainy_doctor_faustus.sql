CREATE TABLE `job_checkpoints` (
	`job_key` text NOT NULL,
	`name` text NOT NULL,
	`reference` text NOT NULL,
	`generation` integer NOT NULL,
	`lease_token` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`job_key`, `name`),
	FOREIGN KEY (`job_key`) REFERENCES `queue_jobs`(`job_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_failures` (
	`job_key` text NOT NULL,
	`generation` integer NOT NULL,
	`attempt` integer NOT NULL,
	`code` text NOT NULL,
	`retryable` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`job_key`, `generation`, `attempt`),
	FOREIGN KEY (`job_key`) REFERENCES `queue_jobs`(`job_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `job_recoveries` (
	`job_key` text NOT NULL,
	`generation` integer NOT NULL,
	`reason_ref` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`job_key`, `generation`),
	FOREIGN KEY (`job_key`) REFERENCES `queue_jobs`(`job_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `queue_jobs` (
	`job_key` text PRIMARY KEY NOT NULL,
	`job_json` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dispatches` integer DEFAULT 0 NOT NULL,
	`available_at` integer DEFAULT 0 NOT NULL,
	`dispatch_at` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer,
	`error_code` text,
	`dead_lettered_at` integer,
	`dlq_attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "queue_jobs_status" CHECK("queue_jobs"."status" IN ('pending','running','retry','completed','dead'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_jobs_dispatch_lookup` ON `queue_jobs` (`status`,`dispatch_at`,`job_key`);--> statement-breakpoint
CREATE TABLE `queue_rejections` (
	`message_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
-- First statement of every checkpoint/application-write batch. RAISE rolls back
-- all writes if a worker lost its lease, including after another worker reclaimed it.
CREATE TRIGGER job_checkpoints_active_lease
BEFORE INSERT ON job_checkpoints
WHEN NOT EXISTS (
  SELECT 1 FROM queue_jobs
  WHERE job_key = NEW.job_key AND generation = NEW.generation
    AND lease_token = NEW.lease_token AND status = 'running'
    AND lease_until > NEW.recorded_at
)
BEGIN
  SELECT RAISE(ABORT, 'JOB_LEASE_LOST');
END;
--> statement-breakpoint
CREATE TRIGGER job_recoveries_validate
BEFORE INSERT ON job_recoveries
WHEN NOT EXISTS (
  SELECT 1 FROM queue_jobs WHERE job_key = NEW.job_key AND status = 'dead'
    AND generation = NEW.generation - 1 AND generation < 3
)
BEGIN
  SELECT RAISE(ABORT, 'JOB_RECOVERY_REJECTED');
END;
--> statement-breakpoint
CREATE TRIGGER job_recoveries_reset
AFTER INSERT ON job_recoveries
BEGIN
  UPDATE queue_jobs SET generation = NEW.generation, status = 'pending', attempts = 0,
    dispatches = 0, error_code = NULL, dead_lettered_at = NULL, dlq_attempts = 0,
    available_at = 0, dispatch_at = 0, lease_token = NULL, lease_until = NULL, updated_at = NEW.recorded_at
  WHERE job_key = NEW.job_key;
END;
