CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`cron` text NOT NULL,
	`prompt` text NOT NULL,
	`persona` text NOT NULL DEFAULT 'build',
	`category` text NOT NULL DEFAULT 'user',
	`enabled` integer DEFAULT true,
	`output` text,
	`last_run` integer,
	`last_status` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduler_log` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`task_name` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL DEFAULT 'running',
	`error` text,
	`session_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
