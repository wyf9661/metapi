CREATE TABLE `site_announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`platform` text NOT NULL,
	`source_key` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`source_url` text,
	`starts_at` text,
	`ends_at` text,
	`upstream_created_at` text,
	`upstream_updated_at` text,
	`first_seen_at` text DEFAULT (datetime('now')),
	`last_seen_at` text DEFAULT (datetime('now')),
	`read_at` text,
	`dismissed_at` text,
	`raw_payload` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_announcements_site_source_key_unique` ON `site_announcements` (`site_id`,`source_key`);
--> statement-breakpoint
CREATE INDEX `site_announcements_site_id_first_seen_at_idx` ON `site_announcements` (`site_id`,`first_seen_at`);
--> statement-breakpoint
CREATE INDEX `site_announcements_read_at_idx` ON `site_announcements` (`read_at`);
