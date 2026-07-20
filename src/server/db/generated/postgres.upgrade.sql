ALTER TABLE "downstream_api_keys" ADD COLUMN "max_daily_requests" INTEGER;
ALTER TABLE "downstream_api_keys" ADD COLUMN "max_daily_cost" DOUBLE PRECISION;
ALTER TABLE "downstream_api_keys" ADD COLUMN "daily_used_requests" INTEGER DEFAULT 0;
ALTER TABLE "downstream_api_keys" ADD COLUMN "daily_used_cost" DOUBLE PRECISION DEFAULT 0;
ALTER TABLE "downstream_api_keys" ADD COLUMN "daily_window_date" TEXT;
