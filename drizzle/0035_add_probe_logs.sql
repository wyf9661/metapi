CREATE TABLE IF NOT EXISTS `probe_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`model_name` text NOT NULL,
	`question_category` text NOT NULL,
	`question_text` text NOT NULL,
	`response_text` text,
	`status` text NOT NULL,
	`latency_ms` integer,
	`tokens_used` integer,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `probe_logs_created_at_idx` ON `probe_logs` (`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `probe_logs_site_created_at_idx` ON `probe_logs` (`site_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `probe_logs_account_created_at_idx` ON `probe_logs` (`account_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `probe_logs_model_created_at_idx` ON `probe_logs` (`model_name`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `probe_logs_status_created_at_idx` ON `probe_logs` (`status`,`created_at`);
