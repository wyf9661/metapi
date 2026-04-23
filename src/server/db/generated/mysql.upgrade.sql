ALTER TABLE `sites` ADD COLUMN `post_refresh_probe_enabled` BOOLEAN DEFAULT false;
ALTER TABLE `sites` ADD COLUMN `post_refresh_probe_model` VARCHAR(191) DEFAULT '';
ALTER TABLE `sites` ADD COLUMN `post_refresh_probe_scope` VARCHAR(191) DEFAULT 'single';
