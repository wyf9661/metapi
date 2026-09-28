import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter downstream allow-list policy', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-allowlist-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  async function seedSiteAndChannel(name: string, modelPattern: string, tokenValue: string) {
    const site = await db.insert(schema.sites).values({
      name,
      url: `https://${name}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${name}`,
      accessToken: `access-${name}`,
      apiToken: tokenValue,
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      enabled: true,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    return { site, account, route, channel };
  }

  it('empty allowedSiteIds allows every site', async () => {
    const a = await seedSiteAndChannel('allow-site-a', 'gpt-4o-mini', 'sk-a');
    const b = await seedSiteAndChannel('allow-site-b', 'gpt-4o-mini', 'sk-b');

    const router = new TokenRouter();
    const policy: any = {
      allowedRouteIds: [a.route.id, b.route.id],
      supportedModels: [],
      siteWeightMultipliers: {},
      allowedSiteIds: [],
      allowedCredentialRefs: [],
    };

    const pick = await router.selectChannel('gpt-4o-mini', policy);
    const decision = await router.explainSelectionForRoute(a.route.id, 'gpt-4o-mini', [], policy);

    expect(pick?.channel.id).toBeTruthy();
    const both = decision.candidates;
    expect(both.every((item) => item.eligible)).toBe(true);
  });

  it('restricts candidates to allowed sites', async () => {
    const allowed = await seedSiteAndChannel('keep-site', 'claude-sonnet-4-6', 'sk-keep');
    const denied = await seedSiteAndChannel('drop-site', 'claude-sonnet-4-6', 'sk-drop');

    const router = new TokenRouter();
    const policy: any = {
      allowedRouteIds: [allowed.route.id, denied.route.id],
      supportedModels: [],
      siteWeightMultipliers: {},
      allowedSiteIds: [allowed.site.id],
      allowedCredentialRefs: [],
    };

    const pick = await router.selectChannel('claude-sonnet-4-6', policy);
    const decision = await router.explainSelectionForRoute(denied.route.id, 'claude-sonnet-4-6', [], policy);
    const deniedCandidate = decision.candidates.find((item) => item.channelId === denied.channel.id);

    expect(pick?.channel.id).toBe(allowed.channel.id);
    expect(deniedCandidate?.eligible).toBe(false);
    expect(deniedCandidate?.reason).toContain('站点未在下游密钥允许列表内');
    expect(deniedCandidate?.reasonCodes).toContain('downstream_excluded');
  });

  it('empty allowedCredentialRefs allows every credential', async () => {
    const a = await seedSiteAndChannel('cred-site-a', 'gpt-5-mini', 'sk-a');
    const b = await seedSiteAndChannel('cred-site-b', 'gpt-5-mini', 'sk-b');

    const router = new TokenRouter();
    const policy: any = {
      allowedRouteIds: [a.route.id, b.route.id],
      supportedModels: [],
      siteWeightMultipliers: {},
      allowedSiteIds: [],
      allowedCredentialRefs: [],
    };

    const pick = await router.selectChannel('gpt-5-mini', policy);
    expect(pick?.channel.id).toBeTruthy();
  });

  it('restricts explicitly bound tokens to allowed credential refs', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'token-site',
      url: 'https://token.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const blockedAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-blocked',
      accessToken: 'access-blocked',
      apiToken: 'sk-blocked-token',
      status: 'active',
    }).returning().get();
    const allowedAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-allowed',
      accessToken: 'access-allowed',
      apiToken: 'sk-allowed',
      status: 'active',
    }).returning().get();

    const blockedToken = await db.insert(schema.accountTokens).values({
      accountId: blockedAccount.id,
      name: 'blocked-token',
      token: 'sk-blocked-token',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();
    const allowedToken = await db.insert(schema.accountTokens).values({
      accountId: allowedAccount.id,
      name: 'allowed-token',
      token: 'sk-allowed-token',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const blockedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: blockedAccount.id,
      tokenId: blockedToken.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const allowedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: allowedAccount.id,
      tokenId: allowedToken.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const policy: any = {
      allowedRouteIds: [route.id],
      supportedModels: [],
      siteWeightMultipliers: {},
      allowedSiteIds: [],
      allowedCredentialRefs: [
        { kind: 'account_token', siteId: site.id, accountId: allowedAccount.id, tokenId: allowedToken.id },
      ],
    };

    const pick = await router.selectChannel('claude-opus-4-6', policy);
    const decision = await router.explainSelectionForRoute(route.id, 'claude-opus-4-6', [], policy);
    const blockedCandidate = decision.candidates.find((item) => item.channelId === blockedChannel.id);

    expect(pick?.channel.id).toBe(allowedChannel.id);
    expect(blockedCandidate?.eligible).toBe(false);
    expect(blockedCandidate?.reason).toContain('API Key/令牌未在下游密钥允许列表内');
  });

  it('restricts default api key channels to allowed credential refs', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'default-site',
      url: 'https://default.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const blockedAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-blocked',
      accessToken: 'access-blocked',
      apiToken: 'sk-blocked-default',
      status: 'active',
    }).returning().get();
    const allowedAccount = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'user-allowed',
      accessToken: 'access-allowed',
      apiToken: 'sk-allowed-default',
      status: 'active',
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4.1',
      enabled: true,
    }).returning().get();

    const blockedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: blockedAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const allowedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: allowedAccount.id,
      tokenId: null,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    const policy: any = {
      allowedRouteIds: [route.id],
      supportedModels: [],
      siteWeightMultipliers: {},
      allowedSiteIds: [site.id],
      allowedCredentialRefs: [
        { kind: 'default_api_key', siteId: site.id, accountId: allowedAccount.id },
      ],
    };

    const pick = await router.selectChannel('gpt-4.1', policy);
    const decision = await router.explainSelectionForRoute(route.id, 'gpt-4.1', [], policy);
    const blockedCandidate = decision.candidates.find((item) => item.channelId === blockedChannel.id);

    expect(pick?.channel.id).toBe(allowedChannel.id);
    expect(blockedCandidate?.eligible).toBe(false);
    expect(blockedCandidate?.reason).toContain('API Key/令牌未在下游密钥允许列表内');
  });
});