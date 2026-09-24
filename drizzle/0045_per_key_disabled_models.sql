ALTER TABLE `site_disabled_models` ADD `account_id` integer REFERENCES `accounts`(`id`) ON DELETE cascade;
--> statement-breakpoint
DROP INDEX IF EXISTS `site_disabled_models_site_model_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `site_disabled_models_site_account_model_unique` ON `site_disabled_models` (`site_id`,`account_id`,`model_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `site_disabled_models_account_id_idx` ON `site_disabled_models` (`account_id`);
