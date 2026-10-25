DROP INDEX IF EXISTS `accounts_oauth_provider_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `accounts_oauth_identity_idx`;
--> statement-breakpoint
DROP INDEX IF EXISTS `route_channels_oauth_route_unit_id_idx`;
--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `oauth_project_id`;
--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `oauth_account_key`;
--> statement-breakpoint
ALTER TABLE `accounts` DROP COLUMN `oauth_provider`;
--> statement-breakpoint
ALTER TABLE `route_channels` DROP COLUMN `oauth_route_unit_id`;
--> statement-breakpoint
DROP TABLE IF EXISTS `oauth_route_unit_members`;
--> statement-breakpoint
DROP TABLE IF EXISTS `oauth_route_units`;
