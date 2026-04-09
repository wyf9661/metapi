CREATE TABLE `admin_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`namespace` text NOT NULL,
	`snapshot_key` text NOT NULL,
	`payload` text NOT NULL,
	`generated_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`stale_until` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_snapshots_namespace_key_unique` ON `admin_snapshots` (`namespace`,`snapshot_key`);--> statement-breakpoint
CREATE INDEX `admin_snapshots_expires_at_idx` ON `admin_snapshots` (`expires_at`);--> statement-breakpoint
CREATE INDEX `admin_snapshots_stale_until_idx` ON `admin_snapshots` (`stale_until`);