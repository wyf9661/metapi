ALTER TABLE `model_availability` ADD COLUMN `consecutive_hard_failures` INT NOT NULL DEFAULT 0;
ALTER TABLE `model_availability` ADD COLUMN `consecutive_successes` INT NOT NULL DEFAULT 0;
ALTER TABLE `model_availability` ADD COLUMN `hard_failure_bits` INT NOT NULL DEFAULT 0;
ALTER TABLE `model_availability` ADD COLUMN `hard_failure_samples` INT NOT NULL DEFAULT 0;
