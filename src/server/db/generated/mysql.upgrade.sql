ALTER TABLE `downstream_api_keys` ADD COLUMN `max_daily_requests` INT;
ALTER TABLE `downstream_api_keys` ADD COLUMN `max_daily_cost` DOUBLE;
ALTER TABLE `downstream_api_keys` ADD COLUMN `daily_used_requests` INT DEFAULT 0;
ALTER TABLE `downstream_api_keys` ADD COLUMN `daily_used_cost` DOUBLE DEFAULT 0;
ALTER TABLE `downstream_api_keys` ADD COLUMN `daily_window_date` TEXT;
