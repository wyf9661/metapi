import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import SiteBadgeLink from './SiteBadgeLink.js';

function badgeTexts(root: ReturnType<typeof create>): string[] {
  const badge = root.root.findByProps({ className: 'badge badge-info' });
  const texts: string[] = [];
  const walk = (children: Array<any>) => {
    for (const child of children) {
      if (typeof child === 'string') texts.push(child);
      else if (child && Array.isArray(child.children)) walk(child.children as Array<any>);
    }
  };
  walk(badge.children as Array<any>);
  return texts;
}

describe('SiteBadgeLink', () => {
  it('renders a focus-navigation link when site id is valid', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink siteId={7} siteName="Demo Site" />
      </MemoryRouter>,
    );

    const link = root.root.findByType('a');
    expect(String(link.props.href || '')).toContain('/sites?focusSiteId=7');
    expect(String(link.props.className || '')).toContain('badge-link');
    expect(badgeTexts(root)).toContain('Demo Site');

    root.unmount();
  });

  it('falls back to plain badge text when site id is invalid', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink siteId={0} siteName="Unknown Site" />
      </MemoryRouter>,
    );

    expect(root.root.findAllByType('a')).toHaveLength(0);
    expect(badgeTexts(root)).toContain('Unknown Site');

    root.unmount();
  });

  it('renders site favicon when site url is available', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink
          siteId={7}
          siteName="Demo Site"
          siteUrl="https://demo.example.com/api"
        />
      </MemoryRouter>,
    );

    const imgs = root.root.findAllByType('img');
    expect(imgs).toHaveLength(1);
    expect(String(imgs[0].props.src)).toBe(
      '/api/site-favicon?url=https%3A%2F%2Fdemo.example.com',
    );

    root.unmount();
  });

  it('stays on letter block for invalid site urls', () => {
    const root = create(
      <MemoryRouter>
        <SiteBadgeLink
          siteId={7}
          siteName="Demo Site"
          siteUrl="javascript:alert(1)"
        />
      </MemoryRouter>,
    );

    expect(root.root.findAllByType('img')).toHaveLength(0);
    expect(badgeTexts(root)).toContain('Demo Site');

    root.unmount();
  });
});
