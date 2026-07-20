CREATE TABLE `telegram_session` (
	`chat_id` text PRIMARY KEY,
	`session_id` text,
	`persona` text,
	`model_override` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `telegram_session_session_id_idx` ON `telegram_session` (`session_id`);
--> statement-breakpoint
CREATE TABLE `job_queue` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`payload` text NOT NULL,
	`result` text,
	`error` text,
	`chat_id` text NOT NULL,
	`ack_message_id` integer,
	`reply_to_message_id` integer,
	`parent_session_id` text,
	`session_id` text,
	`claimed_at` integer,
	`claimed_by` text,
	`attempts` integer NOT NULL DEFAULT 0,
	`cancel_requested` integer NOT NULL DEFAULT false,
	`progress` text,
	`progress_updated_at` integer,
	`delivered` integer NOT NULL DEFAULT false,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `job_queue_status_idx` ON `job_queue` (`status`);
--> statement-breakpoint
CREATE INDEX `job_queue_chat_id_idx` ON `job_queue` (`chat_id`);
--> statement-breakpoint
CREATE INDEX `job_queue_session_id_idx` ON `job_queue` (`session_id`);
--> statement-breakpoint
CREATE TABLE `telegram_inbox` (
	`update_id` integer PRIMARY KEY,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
