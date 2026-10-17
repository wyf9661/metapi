ALTER TABLE "model_availability" ADD COLUMN "consecutive_hard_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "model_availability" ADD COLUMN "consecutive_successes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "model_availability" ADD COLUMN "hard_failure_bits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "model_availability" ADD COLUMN "hard_failure_samples" INTEGER NOT NULL DEFAULT 0;
