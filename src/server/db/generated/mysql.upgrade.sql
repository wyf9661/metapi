ALTER TABLE `proxy_logs` ADD COLUMN `request_trace_id` TEXT;
CREATE INDEX `proxy_logs_request_trace_id_created_at_idx` ON `proxy_logs` (`request_trace_id`(191), `created_at`);
