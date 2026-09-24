DROP INDEX `site_disabled_models_site_model_unique` ON `site_disabled_models`;
ALTER TABLE `site_disabled_models` ADD COLUMN `account_id` INT;
ALTER TABLE `site_disabled_models` ADD CONSTRAINT `site_disabled_models_account_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE;
CREATE UNIQUE INDEX `site_disabled_models_site_account_model_unique` ON `site_disabled_models` (`site_id`, `account_id`, `model_name`(191));
CREATE INDEX `site_disabled_models_account_id_idx` ON `site_disabled_models` (`account_id`);
