import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SiteAnnouncementContent,
  formatSiteAnnouncementSeenAt,
  readClientTimeZone,
  resolveSiteAnnouncementTimeZone,
} from './siteAnnouncementPresentation.js';

const hasDomSanitizerSupport = typeof DOMParser === 'function' && typeof Node !== 'undefined';
const itWithDomSupport = hasDomSanitizerSupport ? it : it.skip;

describe('siteAnnouncementPresentation helpers', () => {
  itWithDomSupport('renders sanitized html notices with safe links', () => {
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

  itWithDomSupport('renders markdown notices as structured content', () => {
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

  it('prefers client timezone over server timezone', () => {
    expect(resolveSiteAnnouncementTimeZone('Asia/Shanghai', 'UTC')).toBe('Asia/Shanghai');
    expect(resolveSiteAnnouncementTimeZone('', 'UTC')).toBe('UTC');
  });

  it('reads the browser timezone when available', () => {
    expect(readClientTimeZone()).toBeTruthy();
  });
});
