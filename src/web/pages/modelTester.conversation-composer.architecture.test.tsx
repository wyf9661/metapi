import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester conversation composer extraction', () => {
  it('no longer embeds conversation composer after the model-check redesign', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8').replace(/\r\n/g, '\n');

    expect(source).not.toContain("import ConversationComposer from './model-tester/ConversationComposer.js'");
    expect(source).toContain('api.probeRemoteUpstream');
  });
});
