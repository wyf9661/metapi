import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop package scripts', () => {
  it('rebuilds the app before package:desktop targets invoke electron-builder', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const scripts = packageJson.scripts || {};
    const packageDesktop = scripts['package:desktop'] || '';
    const packageDesktopIntel = scripts['package:desktop:mac:intel'] || '';
    const distDesktop = scripts['dist:desktop'] || '';
    const distDesktopIntel = scripts['dist:desktop:mac:intel'] || '';

    expect(
      packageDesktop === 'npm run dist:desktop' || packageDesktop.includes('npm run build'),
    ).toBe(true);
    expect(
      packageDesktopIntel === 'npm run dist:desktop:mac:intel' || packageDesktopIntel.includes('npm run build'),
    ).toBe(true);
    expect(distDesktop).toContain('npm run build');
    expect(distDesktopIntel).toContain('npm run build');
  });
});
