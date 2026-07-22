import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function cssRule(css: string, selector: string): string {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start < 0) return '';
  const brace = css.indexOf('{', start);
  const end = css.indexOf('}', brace);
  return css.slice(brace + 1, end);
}

describe('Inventory table actions layout', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
  const sites = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');
  const tokens = readFileSync(resolve(process.cwd(), 'src/web/pages/tokens/TokensPanel.tsx'), 'utf8');
  const accounts = readFileSync(resolve(process.cwd(), 'src/web/pages/Accounts.tsx'), 'utf8');
  const sitesEditor = readFileSync(resolve(process.cwd(), 'src/web/pages/helpers/sitesEditor.ts'), 'utf8');

  it('keeps token row actions under a dedicated left-aligned actions column', () => {
    expect(tokens).toContain('className="token-actions-cell"');
    expect(css).toContain('.token-actions-cell');
    expect(css).toContain('.token-table-actions {');
    expect(cssRule(css, '.token-table-actions')).toContain('justify-content: flex-start');
    expect(cssRule(css, '.token-table-actions')).toContain('flex-wrap: nowrap');
    expect(css).toContain('.token-table {');
    expect(css).toContain('table-layout: fixed;');
  });

  it('keeps site actions on one left-aligned row without external checkin UI', () => {
    expect(sites).toContain('className="sites-actions-cell"');
    expect(sites).toContain('className="sites-row-actions"');
    expect(sites).not.toContain('外部签到站URL');
    expect(sites).not.toContain('外部签到/福利站点 URL');
    expect(sites).not.toContain('externalCheckinUrl');
    expect(sitesEditor).not.toContain('externalCheckinUrl');
    const rule = cssRule(css, '.sites-row-actions');
    expect(rule).toContain('flex-wrap: nowrap');
    expect(rule).toContain('justify-content: flex-start');
    expect(rule).not.toContain('flex-wrap: wrap');
    expect(rule).not.toContain('justify-content: flex-end');
  });

  it('does not reserve oversized right voids for accounts/token action columns', () => {
    expect(accounts).toContain('className="accounts-actions-cell"');
    const accountsRule = cssRule(css, '.accounts-actions-col,\n.accounts-actions-cell')
      || cssRule(css, '.accounts-actions-col,\r\n.accounts-actions-cell');
    // selector may span lines — extract by class marker
    const accStart = css.indexOf('.accounts-actions-col,');
    const accBrace = css.indexOf('{', accStart);
    const accEnd = css.indexOf('}', accBrace);
    const accBody = css.slice(accBrace + 1, accEnd);
    expect(accBody).toContain('width: 22%');
    expect(accBody).not.toContain('width: 30%');
    expect(accBody).not.toContain('width: 38%');

    const tokStart = css.indexOf('.token-table-actions-col,');
    const tokBrace = css.indexOf('{', tokStart);
    const tokEnd = css.indexOf('}', tokBrace);
    const tokBody = css.slice(tokBrace + 1, tokEnd);
    expect(tokBody).toContain('width: 16%');
    expect(tokBody).not.toContain('width: 20%');
  });
});
