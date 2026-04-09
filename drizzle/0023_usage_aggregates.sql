CREATE TABLE `analytics_projection_checkpoints` (
	`projector_key` text PRIMARY KEY NOT NULL,
	`time_zone` text DEFAULT 'Local' NOT NULL,
	`last_proxy_log_id` integer DEFAULT 0 NOT NULL,
	`watermark_created_at` text,
	`recompute_from_id` integer,
	`recompute_requested_at` text,
	`recompute_reason` text,
	`recompute_started_at` text,
	`recompute_completed_at` text,
	`last_projected_at` text,
	`last_successful_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX `analytics_projection_checkpoints_recompute_from_id_idx` ON `analytics_projection_checkpoints` (`recompute_from_id`);--> statement-breakpoint
CREATE TABLE `model_day_usage` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_day_usage_day_site_model_unique` ON `model_day_usage` (`local_day`,`site_id`,`model`);--> statement-breakpoint
CREATE INDEX `model_day_usage_day_idx` ON `model_day_usage` (`local_day`);--> statement-breakpoint
CREATE INDEX `model_day_usage_site_id_idx` ON `model_day_usage` (`site_id`);--> statement-breakpoint
CREATE INDEX `model_day_usage_model_idx` ON `model_day_usage` (`model`);--> statement-breakpoint
CREATE TABLE `site_day_usage` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_day_usage_day_site_unique` ON `site_day_usage` (`local_day`,`site_id`);--> statement-breakpoint
CREATE INDEX `site_day_usage_day_idx` ON `site_day_usage` (`local_day`);--> statement-breakpoint
CREATE INDEX `site_day_usage_site_id_idx` ON `site_day_usage` (`site_id`);--> statement-breakpoint
CREATE TABLE `site_hour_usage` (
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
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_hour_usage_hour_site_unique` ON `site_hour_usage` (`bucket_start_utc`,`site_id`);--> statement-breakpoint
CREATE INDEX `site_hour_usage_hour_idx` ON `site_hour_usage` (`bucket_start_utc`);--> statement-breakpoint
CREATE INDEX `site_hour_usage_site_id_idx` ON `site_hour_usage` (`site_id`);