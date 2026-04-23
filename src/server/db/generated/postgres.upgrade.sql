ALTER TABLE "sites" ADD COLUMN "post_refresh_probe_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "sites" ADD COLUMN "post_refresh_probe_model" TEXT DEFAULT '';
ALTER TABLE "sites" ADD COLUMN "post_refresh_probe_scope" TEXT DEFAULT 'single';
