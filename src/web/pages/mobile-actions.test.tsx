import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function findRuleValue(source: string, selector: string, property: string): number | null {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{[^}]*${property}:\\s*([^;]+)`, 'm'));
  if (!match) return null;
  const rawValue = match[1].trim();
  const directNumber = rawValue.match(/^(\d+)$/);
  if (directNumber) return Number(directNumber[1]);
  const variableName = rawValue.match(/^var\((--[^)]+)\)$/);
  if (!variableName) return null;
  const variableMatch = source.match(new RegExp(`${variableName[1]}:\\s*(\\d+)`, 'm'));
  return variableMatch ? Number(variableMatch[1]) : null;
}

describe('Mobile actions bar styles', () => {
  it('keeps overlay layers above the mobile batch bar', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    const batchBarZIndex = findRuleValue(css, '.mobile-actions-bar', 'z-index');
    const modalBackdropZIndex = findRuleValue(css, '.modal-backdrop', 'z-index');

    expect(batchBarZIndex).not.toBeNull();
    expect(modalBackdropZIndex).not.toBeNull();
    expect(modalBackdropZIndex!).toBeGreaterThan(batchBarZIndex!);
  });
});
