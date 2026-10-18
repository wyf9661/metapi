ALTER TABLE "proxy_logs" ADD COLUMN "token_id" INTEGER;
CREATE INDEX "proxy_logs_token_id_created_at_idx" ON "proxy_logs" ("token_id", "created_at");
