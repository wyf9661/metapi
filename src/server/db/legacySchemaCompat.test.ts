import { describe, expect, it } from 'vitest';
import { classifyLegacyCompatMutation } from './legacySchemaCompat.js';

describe('legacy schema compat boundary', () => {
  it('allows only explicitly registered legacy upgrade shims', () => {
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN billing_details text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN is_stream integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN first_byte_latency_ms integer;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE proxy_logs ADD COLUMN client_app_id text;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX proxy_logs_client_app_id_created_at_idx ON proxy_logs(client_app_id, created_at);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE sites ADD COLUMN brand_new_column text;')).toBe('forbidden');
    expect(classifyLegacyCompatMutation('UPDATE "sites" SET "brand_new_column" = 1')).toBe('forbidden');
  });

  it('classifies the per-key disabled-model shim as legacy on every dialect', () => {
    // Regression: the site_disabled_models.account_id column is registered with
    // table: 'site_disabled_models'; if the whitelist hardcodes the sites table,
    // these get rejected at boot and the column never appears in live databases.
    expect(classifyLegacyCompatMutation('ALTER TABLE site_disabled_models ADD COLUMN account_id integer REFERENCES accounts(id) ON DELETE cascade;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE `site_disabled_models` ADD COLUMN `account_id` INT NULL')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE "site_disabled_models" ADD COLUMN "account_id" INTEGER REFERENCES "accounts"("id") ON DELETE CASCADE')).toBe('legacy');
    expect(classifyLegacyCompatMutation('ALTER TABLE `site_disabled_models` ADD CONSTRAINT `site_disabled_models_account_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('DROP INDEX IF EXISTS site_disabled_models_site_model_unique;')).toBe('legacy');
    expect(classifyLegacyCompatMutation('DROP INDEX `site_disabled_models_site_model_unique` ON `site_disabled_models`')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE UNIQUE INDEX IF NOT EXISTS site_disabled_models_site_account_model_unique ON site_disabled_models (site_id, account_id, model_name);')).toBe('legacy');
    expect(classifyLegacyCompatMutation('CREATE INDEX IF NOT EXISTS site_disabled_models_account_id_idx ON site_disabled_models (account_id);')).toBe('legacy');
  });
});
