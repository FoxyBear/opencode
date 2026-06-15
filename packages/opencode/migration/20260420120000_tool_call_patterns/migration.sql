-- Spec 16: Harness OS — tool-call pattern logging for pre-fetching
CREATE TABLE `tool_call_patterns` (
	`id` text PRIMARY KEY,
	`query_hash` text NOT NULL,
	`query_embedding` blob,
	`tool_sequence` text,
	`frequency` integer DEFAULT 1,
	`last_seen` integer,
	`avg_latency_ms` integer,
	`deterministic` integer DEFAULT 0,
	`project_id` text NOT NULL DEFAULT 'global',
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tcp_query_hash_idx` ON `tool_call_patterns` (`query_hash`);
--> statement-breakpoint
CREATE INDEX `tcp_project_idx` ON `tool_call_patterns` (`project_id`);
