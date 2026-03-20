ALTER TABLE `proxy_logs` ADD `client_family` text;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `client_app_id` text;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `client_app_name` text;--> statement-breakpoint
ALTER TABLE `proxy_logs` ADD `client_confidence` text;--> statement-breakpoint
CREATE INDEX `proxy_logs_client_app_id_created_at_idx` ON `proxy_logs` (`client_app_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `proxy_logs_client_family_created_at_idx` ON `proxy_logs` (`client_family`,`created_at`);
