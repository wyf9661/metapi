CREATE TABLE IF NOT EXISTS `probe_logs` (`id` INT AUTO_INCREMENT NOT NULL PRIMARY KEY, `site_id` INT NOT NULL, `account_id` INT NOT NULL, `model_name` TEXT NOT NULL, `question_category` TEXT NOT NULL, `question_text` TEXT NOT NULL, `response_text` TEXT, `status` TEXT NOT NULL, `latency_ms` INT, `tokens_used` INT, `error_message` TEXT, `created_at` VARCHAR(191) DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')), FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE, FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON DELETE CASCADE);
CREATE INDEX `probe_logs_account_created_at_idx` ON `probe_logs` (`account_id`, `created_at`);
CREATE INDEX `probe_logs_created_at_idx` ON `probe_logs` (`created_at`);
CREATE INDEX `probe_logs_model_created_at_idx` ON `probe_logs` (`model_name`(191), `created_at`);
CREATE INDEX `probe_logs_site_created_at_idx` ON `probe_logs` (`site_id`, `created_at`);
CREATE INDEX `probe_logs_status_created_at_idx` ON `probe_logs` (`status`(191), `created_at`);
