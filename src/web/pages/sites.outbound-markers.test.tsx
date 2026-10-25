import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
  SiteConnectionStats,
  SiteOutboundFlags,
  countSiteCustomHeaders,
  hasSiteOutboundProxy,
} from './sites/sitePresentation.js';

function renderOnce(element: ReactElement): ReactTestRenderer {
  let root!: ReactTestRenderer;
  act(() => {
    root = create(element);
  });
  return root;
}

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

function collectTooltips(root: ReactTestRenderer): string[] {
  return root.root
    .findAll((node) => typeof node.props?.content === 'string')
    .map((node) => String(node.props.content));
}

describe('site outbound markers', () => {
  it('counts headers from the serialized map and ignores every empty shape', () => {
    expect(countSiteCustomHeaders(JSON.stringify({ Authorization: 'x', 'User-Agent': 'y' }))).toBe(2);
    expect(countSiteCustomHeaders('')).toBe(0);
    expect(countSiteCustomHeaders(null)).toBe(0);
    expect(countSiteCustomHeaders(undefined)).toBe(0);
    expect(countSiteCustomHeaders('{}')).toBe(0);
    expect(countSiteCustomHeaders('[]')).toBe(0);
    expect(countSiteCustomHeaders('not json')).toBe(0);
  });

  it('treats a blank proxy url as unset', () => {
    expect(hasSiteOutboundProxy('http://127.0.0.1:7890')).toBe(true);
    expect(hasSiteOutboundProxy('socks5://127.0.0.1:1080')).toBe(true);
    expect(hasSiteOutboundProxy('   ')).toBe(false);
    expect(hasSiteOutboundProxy(null)).toBe(false);
    expect(hasSiteOutboundProxy(undefined)).toBe(false);
  });

  it('renders no marker for a site on the default outbound path', () => {
    const root = renderOnce(<SiteOutboundFlags proxyUrl="" customHeaders="" />);
    expect(root.toJSON()).toBeNull();
  });

  it('marks a site that routes through its own proxy', () => {
    const root = renderOnce(<SiteOutboundFlags proxyUrl="http://127.0.0.1:7890" customHeaders="" />);
    expect(collectTooltips(root)).toEqual(['已配置出站代理']);
  });

  it('marks custom headers with their count and the override flag', () => {
    const root = renderOnce(
      <SiteOutboundFlags
        proxyUrl=""
        customHeaders={JSON.stringify({ Authorization: 'x' })}
        customHeadersOverrideRequestHeaders
      />,
    );
    expect(collectTooltips(root)).toEqual(['已配置自定义请求头 1 项，覆盖上游同名请求头']);
  });

  it('marks both when a site has a proxy and custom headers', () => {
    const root = renderOnce(
      <SiteOutboundFlags
        proxyUrl="http://127.0.0.1:7890"
        customHeaders={JSON.stringify({ a: '1', b: '2' })}
      />,
    );
    expect(collectTooltips(root)).toEqual(['已配置出站代理', '已配置自定义请求头 2 项']);
  });

  it('renders connection counts as stroke icons instead of emoji', () => {
    const root = renderOnce(
      <SiteConnectionStats stats={{ sessions: 2, apiKeys: 1, tokens: 3 }} />,
    );

    // Hidden counts stay hidden: only the three non-zero markers render.
    expect(root.root.findAllByType('svg')).toHaveLength(3);
    expect(collectText(root.root)).toBe('213');
    expect(collectTooltips(root)).toEqual(['Session 账号', 'API Key', '令牌']);
  });

  it('falls back to a dash when every count is zero', () => {
    const root = renderOnce(
      <SiteConnectionStats stats={{ sessions: 0, apiKeys: 0, tokens: 0 }} />,
    );
    expect(collectText(root.root)).toBe('-');
    expect(root.root.findAllByType('svg')).toHaveLength(0);
  });

  it('leaves no emoji connection glyphs in the sites list', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');
    expect(source).not.toMatch(/[\u{1F464}\u{1F511}\u{1F3AB}\u{1F513}]/u);
    // Both surfaces render the shared marker components.
    expect(source.match(/<SiteConnectionStats/g)).toHaveLength(2);
    expect(source.match(/<SiteOutboundFlags/g)).toHaveLength(2);
  });

  it('keeps every MiniIcon geometry unique across the set', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/components/MiniIcons.tsx'), 'utf8');
    const paths = [...source.matchAll(/<(?:path|rect|circle|polygon|line|polyline)[^>]*?\bd="([^"]+)"/g)].map((m) => m[1]);
    const attrs = [...source.matchAll(/<(?:rect|circle)[^>]*?(?:x|cx)="(-?[\d.]+)"[^>]*?(?:y|cy)="(-?[\d.]+)"[^>]*?(?:width="([\d.]+)"|r="([\d.]+)")/g)].map((m) => m.slice(1).join(','));
    const all = [...paths, ...attrs];
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(all.length);
  });
});
