import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { readAllCss } from './readStyles.testutil.js';

function rules(source: string): string[] {
  return postcss.parse(source).nodes.flatMap((node) => node.type === 'atrule' && node.name === 'import' ? [] : [node.toString()]);
}

const extractedStyles = [
  { path: 'src/web/styles/oauth.css', marker: '.oauth-toolbar-card', minRules: 20 },
  { path: 'src/web/styles/login.css', marker: '.login-shell', minRules: 20 },
  { path: 'src/web/styles/route-cards.css', marker: '.route-filter-bar', minRules: 20 },
  { path: 'src/web/styles/dashboard-endpoints.css', marker: '.dashboard-endpoint-card', minRules: 10 },
];

describe('style source modularization', () => {
  it('inlines each extracted stylesheet intact at its import position', () => {
    const expandedRules = rules(readAllCss());
    for (const stylesheet of extractedStyles) {
      const stylesheetRules = rules(readFileSync(resolve(process.cwd(), stylesheet.path), 'utf8'));
      expect(stylesheetRules.length, stylesheet.path).toBeGreaterThan(stylesheet.minRules);
      expect(stylesheetRules.some((rule) => rule.includes(stylesheet.marker)), stylesheet.path).toBe(true);
      const start = expandedRules.indexOf(stylesheetRules[0]!);
      expect(start, `${stylesheet.path} should be present in the expanded cascade`).toBeGreaterThanOrEqual(0);
      expect(expandedRules.slice(start, start + stylesheetRules.length)).toEqual(stylesheetRules);
    }
  });

  it('keeps the page stylesheets in their original cascade order', () => {
    const expanded = readAllCss();
    const oauth = expanded.indexOf('.oauth-toolbar-card');
    const login = expanded.indexOf('.login-shell');
    const routes = expanded.indexOf('.route-filter-bar');
    const endpoints = expanded.indexOf('.dashboard-endpoint-card');
    expect(oauth).toBeGreaterThan(0);
    expect(login).toBeGreaterThan(oauth);
    expect(routes).toBeGreaterThan(login);
    expect(endpoints).toBeGreaterThan(routes);
  });
});
