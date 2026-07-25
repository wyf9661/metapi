import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester fixed channel behavior', () => {
  it('stores only remote check draft state after the model-check redesign', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8');
    expect(source).not.toContain('forcedChannelId');
    expect(source).not.toContain('serializeModelTesterSession');
    expect(source).toContain('metapi.model-check.v1');
    expect(source).not.toContain('apiKey,\n        protocol');
  });
});
