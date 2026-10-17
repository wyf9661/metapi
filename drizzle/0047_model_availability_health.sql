ALTER TABLE `model_availability` ADD `consecutive_hard_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `model_availability` ADD `consecutive_successes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `model_availability` ADD `hard_failure_bits` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `model_availability` ADD `hard_failure_samples` integer DEFAULT 0 NOT NULL;
