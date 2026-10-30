import { describe, expect, it } from 'vitest';
import { readAllCss } from '../styles/readStyles.testutil.js';

describe('Mobile layout shell styles', () => {
  it('allows page actions and pagination to wrap on narrow screens', () => {
    const css = readAllCss().replace(/\r\n/g, '\n');

    expect(css).toContain('.page-actions {\n    width: 100%;');
    expect(css).toContain('.page-actions {\n    width: 100%;\n    flex-wrap: wrap;');
    expect(css).toContain('.pagination {\n    flex-wrap: wrap;');
  });
});
