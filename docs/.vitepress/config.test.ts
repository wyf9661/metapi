import { existsSync, globSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from './config';

const getAliasEntry = (aliasConfig: unknown, specifier: string) => {
  if (!aliasConfig) return undefined;

  if (Array.isArray(aliasConfig)) {
    return aliasConfig.find(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        'find' in entry &&
        ((typeof entry.find === 'string' && entry.find === specifier) ||
          (entry.find instanceof RegExp && entry.find.test(specifier))),
    );
  }

  if (typeof aliasConfig === 'object' && aliasConfig !== null && specifier in aliasConfig) {
    return {
      find: specifier,
      replacement: String((aliasConfig as Record<string, unknown>)[specifier]),
    };
  }

  return undefined;
};

const getAlias = (aliasConfig: unknown, specifier: string): string | undefined => {
  const aliasEntry = getAliasEntry(aliasConfig, specifier);
  return aliasEntry && typeof aliasEntry === 'object' && 'replacement' in aliasEntry ? String(aliasEntry.replacement) : undefined;
};

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const getExpectedEntry = (hoistedRelativePath: string, pnpmPattern: string) => {
  let currentRoot = repoRoot;

  while (true) {
    const hoistedEntry = resolve(currentRoot, hoistedRelativePath);
    if (existsSync(hoistedEntry)) return hoistedEntry;

    const [pnpmEntry] = globSync(resolve(currentRoot, pnpmPattern));
    if (pnpmEntry) return pnpmEntry;

    const parentRoot = dirname(currentRoot);
    if (parentRoot === currentRoot) break;
    currentRoot = parentRoot;
  }

  return undefined;
};

describe('docs vitepress config', () => {
  it('ships copied main-app favicon assets for docs', () => {
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon.png'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon-64.png'))).toBe(true);
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon.ico'))).toBe(true);
  });

  it('ships a fallback favicon.ico for browsers that probe the default path', () => {
    expect(existsSync(resolve(repoRoot, 'docs/public/favicon.ico'))).toBe(true);
  });

  it('declares the main-app favicon assets in docs head tags', () => {
    const iconLinks =
      config.head?.filter(
        (entry) =>
          entry[0] === 'link' &&
          typeof entry[1] === 'object' &&
          entry[1] !== null &&
          'rel' in entry[1] &&
          (entry[1].rel === 'icon' || entry[1].rel === 'shortcut icon'),
      ) ?? [];

    expect(iconLinks.some((entry) => typeof entry[1] === 'object' && entry[1] !== null && 'href' in entry[1] && entry[1].href === '/favicon.png')).toBe(true);
    expect(iconLinks.some((entry) => typeof entry[1] === 'object' && entry[1] !== null && 'href' in entry[1] && entry[1].href === '/favicon-64.png')).toBe(true);
    expect(iconLinks.some((entry) => typeof entry[1] === 'object' && entry[1] !== null && 'href' in entry[1] && entry[1].href === '/favicon.ico')).toBe(true);
  });

  it('aliases dayjs to the ESM entry for mermaid browser compatibility', () => {
    const aliasConfig = config.vite?.resolve?.alias;
    const alias = getAlias(aliasConfig, 'dayjs');
    const aliasEntry = getAliasEntry(aliasConfig, 'dayjs');

    expect(alias).toBe(getExpectedEntry('node_modules/dayjs/esm/index.js', 'node_modules/.pnpm/dayjs@*/node_modules/dayjs/esm/index.js'));
    expect(alias && existsSync(alias)).toBe(true);
    expect(Array.isArray(aliasConfig)).toBe(true);
    expect(aliasEntry && typeof aliasEntry === 'object' && 'find' in aliasEntry && aliasEntry.find instanceof RegExp).toBe(true);
    expect(aliasEntry && typeof aliasEntry === 'object' && 'find' in aliasEntry && aliasEntry.find instanceof RegExp && aliasEntry.find.test('dayjs/plugin/duration.js')).toBe(false);
  });

  it('aliases sanitize-url to a browser-loadable source entry', () => {
    const alias = getAlias(config.vite?.resolve?.alias, '@braintree/sanitize-url');

    expect(alias).toBe(
      getExpectedEntry(
        'node_modules/@braintree/sanitize-url/src/index.ts',
        'node_modules/.pnpm/@braintree+sanitize-url@*/node_modules/@braintree/sanitize-url/src/index.ts',
      ),
    );
    expect(alias && existsSync(alias)).toBe(true);
  });
});
