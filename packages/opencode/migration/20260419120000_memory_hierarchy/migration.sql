-- Spec 10: Memory Hierarchy — 3-tier architecture
-- Adds project scoping to instance memory + graph tables for project/global tiers

-- Instance memory: add project_id (backfill existing as "global")
ALTER TABLE `memory_topics` ADD COLUMN `project_id` text NOT NULL DEFAULT 'global';
--> statement-breakpoint
CREATE INDEX `memory_topics_project_idx` ON `memory_topics` (`project_id`);
--> statement-breakpoint
ALTER TABLE `memory_index` ADD COLUMN `project_id` text NOT NULL DEFAULT 'global';
--> statement-breakpoint
CREATE INDEX `memory_index_project_idx` ON `memory_index` (`project_id`);
--> statement-breakpoint

-- Graph entity nodes (project + global tiers)
CREATE TABLE `graph_entity` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL DEFAULT 'global',
	`name` text NOT NULL,
	`entity_type` text NOT NULL,
	`content` text NOT NULL,
	`embedding` blob,
	`metadata` text,
	`valid_from` integer NOT NULL,
	`invalid_from` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_entity_project_idx` ON `graph_entity` (`project_id`);
--> statement-breakpoint
CREATE INDEX `graph_entity_type_idx` ON `graph_entity` (`entity_type`);
--> statement-breakpoint
CREATE INDEX `graph_entity_name_idx` ON `graph_entity` (`name`);
--> statement-breakpoint

-- Graph edges (bi-temporal, never deleted)
CREATE TABLE `graph_edge` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL DEFAULT 'global',
	`source_id` text NOT NULL REFERENCES `graph_entity`(`id`),
	`target_id` text NOT NULL REFERENCES `graph_entity`(`id`),
	`edge_type` text NOT NULL,
	`weight` real DEFAULT 1.0,
	`valid_from` integer NOT NULL,
	`invalid_from` integer,
	`source_project` text,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_edge_source_idx` ON `graph_edge` (`source_id`);
--> statement-breakpoint
CREATE INDEX `graph_edge_target_idx` ON `graph_edge` (`target_id`);
--> statement-breakpoint
CREATE INDEX `graph_edge_project_idx` ON `graph_edge` (`project_id`);
--> statement-breakpoint
CREATE INDEX `graph_edge_type_idx` ON `graph_edge` (`edge_type`);
--> statement-breakpoint
CREATE INDEX `graph_edge_valid_idx` ON `graph_edge` (`valid_from`, `invalid_from`);
