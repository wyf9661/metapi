import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProbeLogs detail modal', () => {
  it('renders the detail dialog through the shared portal modal instead of an inline fixed overlay', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProbeLogs.tsx'), 'utf8');

    expect(source).toContain("import CenteredModal from '../components/CenteredModal.js'");
    expect(source).toContain("import MobileDrawer from '../components/MobileDrawer.js'");
    expect(source).toContain('<CenteredModal');
    expect(source).toContain('<MobileDrawer');

    // Inline fixed overlays inside the page scroll container are what forced
    // users to scroll the page horizontally to find the dialog.
    expect(source).not.toContain('fixed inset-0');
    expect(source).not.toContain('bg-black/50');
  });
});
