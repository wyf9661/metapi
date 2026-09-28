import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type BackfillModule = typeof import('./oauthIdentityBackfill.js');

/**
 * Legacy accounts used to carry their OAuth identity inside `extra_config.oauth`
 * only; the structured `oauth_provider` / `oauth_account_key` / `oauth_project_id`
 * columns were added later. The boot backfill promotes the legacy identity into
 * those columns and must leave already-structured accounts untouched.
 *
 * The scan is pre-filtered in SQL down to rows with a missing structured column;
 * that filter is a superset of "row needs a patch", so the provider-only and
 * key-only cases below pin the boundary it must not over-narrow.
 */
describe('ensureOauthIdentityBackfill', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ensureBackfill: BackfillModule['ensureOauthIdentityBackfill'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-oauth-backfill-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const backfillModule = await import('./oauthIdentityBackfill.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ensureBackfill = backfillModule.ensureOauthIdentityBackfill;
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  const insertSite = async (name: string) => db.insert(schema.sites).values({
    name,
    url: `https://${name}.example.com`,
    platform: 'new-api',
  }).returning().get();

  const insertAccount = async (overrides: {
    siteId: number;
    oauthProvider?: string | null;
    oauthAccountKey?: string | null;
    oauthProjectId?: string | null;
    extraConfig?: string | null;
  }) => db.insert(schema.accounts).values({
    siteId: overrides.siteId,
    username: null,
    accessToken: 'access-token',
    oauthProvider: overrides.oauthProvider ?? null,
    oauthAccountKey: overrides.oauthAccountKey ?? null,
    oauthProjectId: overrides.oauthProjectId ?? null,
    extraConfig: overrides.extraConfig ?? null,
  }).returning().get();

  it('promotes a legacy identity out of extra_config into the structured columns', async () => {
    const site = await insertSite('legacy-identity');
    const account = await insertAccount({
      siteId: site.id,
      extraConfig: JSON.stringify({
        oauth: { provider: 'codex', accountKey: 'json-user', projectId: 'json-project' },
      }),
    });

    const updated = await ensureBackfill();

    expect(updated).toBe(1);
    const after = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(after).toMatchObject({
      oauthProvider: 'codex',
      oauthAccountKey: 'json-user',
      oauthProjectId: 'json-project',
    });
  });

  it('still patches an account whose provider is structured but key and project are not', async () => {
    const site = await insertSite('partial-identity');
    const account = await insertAccount({
      siteId: site.id,
      oauthProvider: 'codex',
      extraConfig: JSON.stringify({
        oauth: { provider: 'codex', accountKey: 'json-user', projectId: 'json-project' },
      }),
    });

    const updated = await ensureBackfill();

    expect(updated).toBe(1);
    const after = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(after).toMatchObject({
      oauthProvider: 'codex',
      oauthAccountKey: 'json-user',
      oauthProjectId: 'json-project',
    });
  });

  it('leaves an account with a complete structured identity untouched', async () => {
    const site = await insertSite('structured-identity');
    const account = await insertAccount({
      siteId: site.id,
      oauthProvider: 'gemini-cli',
      oauthAccountKey: 'structured-user@example.com',
      oauthProjectId: 'structured-project',
      extraConfig: JSON.stringify({
        oauth: { provider: 'codex', accountKey: 'json-user', projectId: 'json-project' },
      }),
    });

    const updated = await ensureBackfill();

    expect(updated).toBe(0);
    const after = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(after?.oauthProvider).toBe('gemini-cli');
    expect(after?.oauthAccountKey).toBe('structured-user@example.com');
    expect(after?.oauthProjectId).toBe('structured-project');
    expect(after?.updatedAt).toBe(account.updatedAt);
  });

  it('ignores accounts that carry no legacy oauth identity at all', async () => {
    const site = await insertSite('plain-account');
    await insertAccount({
      siteId: site.id,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    });

    const updated = await ensureBackfill();

    expect(updated).toBe(0);
  });
});
