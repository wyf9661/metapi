import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Accounts centered modal adoption', () => {
  it('uses CenteredModal for add/edit/rebind flows instead of inline panel cards', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Accounts.tsx'), 'utf8');

    expect(source).toContain(
      'import CenteredModal from "../components/CenteredModal.js";',
    );
    expect(source).toContain('<CenteredModal');
    expect(source).not.toContain('className={`card panel-presence rebind-panel');
  });
});
