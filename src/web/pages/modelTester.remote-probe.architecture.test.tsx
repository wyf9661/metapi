import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelTester remote probe redesign', () => {
  it('is a vertical model-check page driven by remote URL/key model list', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelTester.tsx'), 'utf8');

    expect(source).toContain('api.listRemoteUpstreamModels');
    expect(source).toContain('api.probeRemoteUpstream');
    expect(source).toContain('模型检测');
    expect(source).toContain("value: 'completion'");
    expect(source).toContain("value: 'anthropic'");
    expect(source).toContain("value: 'responses'");
    expect(source).toContain("flexDirection: 'column'");
    expect(source).not.toContain('也可直接填写模型 ID');
    expect(source).not.toContain('探测提示词');
    expect(source).not.toContain('ConversationComposer');
    expect(source).toContain('searchable');
    expect(source).toContain('搜索模型');
    expect(source).not.toContain('筛选模型');
    expect(source).not.toContain('modelSearch');
  });
});
