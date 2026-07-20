ALTER TABLE `downstream_api_keys` ADD `max_daily_requests` integer;
--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `max_daily_cost` real;
--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `daily_used_requests` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `daily_used_cost` real DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `downstream_api_keys` ADD `daily_window_date` text;
