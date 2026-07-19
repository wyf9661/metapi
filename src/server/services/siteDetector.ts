import { detectPlatform } from './platforms/index.js';
import { analyzePrimarySiteUrl } from '../../shared/sitePrimaryUrl.js';

export async function detectSite(url: string) {
  const analyzed = analyzePrimarySiteUrl(url);
  const detectionUrl = analyzed.canonicalUrl;
  const persistedUrl = analyzed.persistedUrl || detectionUrl;
  const adapter = await detectPlatform(detectionUrl);
  if (!adapter) return null;
  return { url: persistedUrl, platform: adapter.platformName };
}