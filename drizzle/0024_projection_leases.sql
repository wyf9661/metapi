ALTER TABLE `analytics_projection_checkpoints` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `analytics_projection_checkpoints` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `analytics_projection_checkpoints` ADD `lease_expires_at` text;--> statement-breakpoint
CREATE INDEX `analytics_projection_checkpoints_lease_expires_at_idx` ON `analytics_projection_checkpoints` (`lease_expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_model_day_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_day` text NOT NULL,
	`site_id` integer NOT NULL,
	`model` text NOT NULL,
	`total_calls` integer DEFAULT 0 NOT NULL,
	`success_calls` integer DEFAULT 0 NOT NULL,
	`failed_calls` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_spend` real DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`latency_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "model_day_usage_non_negative" CHECK("__new_model_day_usage"."total_calls" >= 0 and "__new_model_day_usage"."success_calls" >= 0 and "__new_model_day_usage"."failed_calls" >= 0 and "__new_model_day_usage"."total_tokens" >= 0 and "__new_model_day_usage"."total_spend" >= 0 and "__new_model_day_usage"."total_latency_ms" >= 0 and "__new_model_day_usage"."latency_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_model_day_usage`("id", "local_day", "site_id", "model", "total_calls", "success_calls", "failed_calls", "total_tokens", "total_spend", "total_latency_ms", "latency_count", "created_at", "updated_at") SELECT "id", "local_day", "site_id", "model", "total_calls", "success_calls", "failed_calls", "total_tokens", "total_spend", "total_latency_ms", "latency_count", "created_at", "updated_at" FROM `model_day_usage`;--> statement-breakpoint
DROP TABLE `model_day_usage`;--> statement-breakpoint
ALTER TABLE `__new_model_day_usage` RENAME TO `model_day_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `model_day_usage_day_site_model_unique` ON `model_day_usage` (`local_day`,`site_id`,`model`);--> statement-breakpoint
CREATE INDEX `model_day_usage_day_idx` ON `model_day_usage` (`local_day`);--> statement-breakpoint
CREATE INDEX `model_day_usage_site_id_idx` ON `model_day_usage` (`site_id`);--> statement-breakpoint
CREATE INDEX `model_day_usage_model_idx` ON `model_day_usage` (`model`);--> statement-breakpoint
CREATE TABLE `__new_site_day_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_day` text NOT NULL,
	`site_id` integer NOT NULL,
	`total_calls` integer DEFAULT 0 NOT NULL,
	`success_calls` integer DEFAULT 0 NOT NULL,
	`failed_calls` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_summary_spend` real DEFAULT 0 NOT NULL,
	`total_site_spend` real DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`latency_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_day_usage_non_negative" CHECK("__new_site_day_usage"."total_calls" >= 0 and "__new_site_day_usage"."success_calls" >= 0 and "__new_site_day_usage"."failed_calls" >= 0 and "__new_site_day_usage"."total_tokens" >= 0 and "__new_site_day_usage"."total_summary_spend" >= 0 and "__new_site_day_usage"."total_site_spend" >= 0 and "__new_site_day_usage"."total_latency_ms" >= 0 and "__new_site_day_usage"."latency_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_site_day_usage`("id", "local_day", "site_id", "total_calls", "success_calls", "failed_calls", "total_tokens", "total_summary_spend", "total_site_spend", "total_latency_ms", "latency_count", "created_at", "updated_at") SELECT "id", "local_day", "site_id", "total_calls", "success_calls", "failed_calls", "total_tokens", "total_summary_spend", "total_site_spend", "total_latency_ms", "latency_count", "created_at", "updated_at" FROM `site_day_usage`;--> statement-breakpoint
DROP TABLE `site_day_usage`;--> statement-breakpoint
ALTER TABLE `__new_site_day_usage` RENAME TO `site_day_usage`;--> statement-breakpoint
CREATE UNIQUE INDEX `site_day_usage_day_site_unique` ON `site_day_usage` (`local_day`,`site_id`);--> statement-breakpoint
CREATE INDEX `site_day_usage_day_idx` ON `site_day_usage` (`local_day`);--> statement-breakpoint
CREATE INDEX `site_day_usage_site_id_idx` ON `site_day_usage` (`site_id`);--> statement-breakpoint
CREATE TABLE `__new_site_hour_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket_start_utc` text NOT NULL,
	`site_id` integer NOT NULL,
	`total_calls` integer DEFAULT 0 NOT NULL,
	`success_calls` integer DEFAULT 0 NOT NULL,
	`failed_calls` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`total_summary_spend` real DEFAULT 0 NOT NULL,
	`total_site_spend` real DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL,
	`latency_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "site_hour_usage_non_negative" CHECK("__new_site_hour_usage"."total_calls" >= 0 and "__new_site_hour_usage"."success_calls" >= 0 and "__new_site_hour_usage"."failed_calls" >= 0 and "__new_site_hour_usage"."total_tokens" >= 0 and "__new_site_hour_usage"."total_summary_spend" >= 0 and "__new_site_hour_usage"."total_site_spend" >= 0 and "__new_site_hour_usage"."total_latency_ms" >= 0 and "__new_site_hour_usage"."latency_count" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_site_hour_usage`("id", "bucket_start_utc", "site_id", "total_calls", "success_calls", "failed_calls", "total_tokens", "total_summary_spend", "total_site_spend", "total_latency_ms", "latency_count", "created_at", "updated_at") SELECT "id", "bucket_start_utc", "site_id", "total_calls", "success_calls", "failed_calls", "total_tokens", "total_summary_spend", "total_site_spend", "total_latency_ms", "latency_count", "created_at", "updated_at" FROM `site_hour_usage`;--> statement-breakpoint
DROP TABLE `site_hour_usage`;--> statement-breakpoint
ALTER TABLE `__new_site_hour_usage` RENAME TO `site_hour_usage`;--> statement-breakpoint
CREATE UNIQUE INDEX `site_hour_usage_hour_site_unique` ON `site_hour_usage` (`bucket_start_utc`,`site_id`);--> statement-breakpoint
CREATE INDEX `site_hour_usage_hour_idx` ON `site_hour_usage` (`bucket_start_utc`);--> statement-breakpoint
CREATE INDEX `site_hour_usage_site_id_idx` ON `site_hour_usage` (`site_id`);