ALTER TABLE `proxy_logs` ADD `request_trace_id` text;--> statement-breakpoint
CREATE INDEX `proxy_logs_request_trace_id_created_at_idx` ON `proxy_logs` (`request_trace_id`,`created_at`);
