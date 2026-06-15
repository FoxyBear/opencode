CREATE TABLE `memory_index` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL,
	`pointer` text NOT NULL,
	`summary` text NOT NULL,
	`access_count` integer DEFAULT 0,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_index_key_idx` ON `memory_index` (`key`);
--> statement-breakpoint
CREATE TABLE `memory_topics` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`embedding` blob NOT NULL,
	`persona` text NOT NULL,
	`scope` text DEFAULT 'general',
	`access_count` integer DEFAULT 0,
	`metadata` text,
	`time_accessed` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_topics_persona_idx` ON `memory_topics` (`persona`);
--> statement-breakpoint
CREATE INDEX `memory_topics_scope_idx` ON `memory_topics` (`scope`);
