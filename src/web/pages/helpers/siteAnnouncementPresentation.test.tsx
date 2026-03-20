import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SiteAnnouncementContent,
  formatSiteAnnouncementSeenAt,
  readClientTimeZone,
} from './siteAnnouncementPresentation.js';

type BrowserGlobals = {
  window?: Window & typeof globalThis;
  document?: Document;
  DOMParser?: typeof DOMParser;
  Node?: typeof Node;
};

const browserGlobals = globalThis as typeof globalThis & BrowserGlobals;
const originalWindow = browserGlobals.window;
const originalDocument = browserGlobals.document;
const originalDOMParser = browserGlobals.DOMParser;
const originalNode = browserGlobals.Node;

describe('siteAnnouncementPresentation helpers', () => {
  beforeEach(() => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    browserGlobals.window = dom.window as unknown as Window & typeof globalThis;
    browserGlobals.document = dom.window.document;
    browserGlobals.DOMParser = dom.window.DOMParser;
    browserGlobals.Node = dom.window.Node;
  });

  afterEach(() => {
    browserGlobals.window = originalWindow;
    browserGlobals.document = originalDocument;
    browserGlobals.DOMParser = originalDOMParser;
    browserGlobals.Node = originalNode;
  });

  it('renders sanitized html notices with safe links', () => {
    const markup = renderToStaticMarkup(
      <SiteAnnouncementContent
        content={[
          '<h2>Notice</h2>',
          '<p>Welcome <strong>back</strong>.</p>',
          '<script>alert(1)</script>',
          '<a href="javascript:alert(1)" onclick="alert(1)">bad</a>',
          '<a href="https://example.com/docs" target="_blank">docs</a>',
        ].join('')}
      />,
    );

    expect(markup).toContain('<h2>Notice</h2>');
    expect(markup).toContain('<strong>back</strong>');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('onclick=');
    expect(markup).not.toContain('javascript:alert');
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it('renders markdown notices as structured content', () => {
    const markup = renderToStaticMarkup(
      <SiteAnnouncementContent
        content={[
          '# README.md',
          '',
          '这是一个 [接入文档](https://example.com/setup)。',
          '',
          '```json',
          '{',
          '  "model": "gpt-5.4"',
          '}',
          '```',
        ].join('\n')}
      />,
    );

    expect(markup).toContain('<h1>README.md</h1>');
    expect(markup).toContain('href="https://example.com/setup"');
    expect(markup).toContain('<pre><code class="language-json">');
    expect(markup).toContain('&quot;model&quot;: &quot;gpt-5.4&quot;');
  });

  it('formats first-seen time in the requested local timezone', () => {
    expect(formatSiteAnnouncementSeenAt('2026-03-20 04:23:27', 'Asia/Shanghai')).toBe('2026/03/20 12:23:27');
  });

  it('reads the browser timezone when available', () => {
    expect(readClientTimeZone()).toBeTruthy();
  });
});
