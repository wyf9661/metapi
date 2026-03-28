import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getOAuthProviderDefinition } from './providers.js';
import { resolveSiteProxyUrlByRequestUrl } from '../siteProxy.js';

export async function resolveOauthProviderProxyUrl(provider: string): Promise<string | null> {
  const definition = getOAuthProviderDefinition(provider);
  if (!definition) return null;
  return resolveSiteProxyUrlByRequestUrl(definition.site.url);
}

export async function resolveOauthAccountProxyUrl(siteId: number | null | undefined): Promise<string | null> {
  if (!siteId || siteId <= 0) return null;
  const site = await db.select({
    url: schema.sites.url,
  }).from(schema.sites).where(eq(schema.sites.id, siteId)).get();
  if (!site?.url) return null;
  return resolveSiteProxyUrlByRequestUrl(site.url);
}
