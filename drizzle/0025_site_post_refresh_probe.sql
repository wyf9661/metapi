ALTER TABLE `sites` ADD `post_refresh_probe_enabled` integer DEFAULT false;
ALTER TABLE `sites` ADD `post_refresh_probe_model` text DEFAULT '';
ALTER TABLE `sites` ADD `post_refresh_probe_scope` text DEFAULT 'single';
