import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  __setModelsDevCapabilitiesForTests,
  lookupModelsDevCapabilities,
  parseModelsDevCapabilities,
  type ModelsDevCapabilities,
} from './modelCapabilitiesService.js';

// Real models.dev/api.json shape (verified 2026-08-10):
// modalities.input/output arrays, reasoning bool, tool_call bool, limit {context, output}
const SAMPLE_PAYLOAD = JSON.stringify({
  openai: {
    id: 'openai',
    models: {
      'gpt-4o': {
        id: 'gpt-4o',
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: false,
        tool_call: true,
        limit: { context: 128000, output: 16384 },
      },
      'gpt-4o-2024-08-06': {
        id: 'gpt-4o-2024-08-06',
        modalities: { input: ['text', 'image'], output: ['text'] },
        reasoning: false,
        tool_call: true,
        limit: { context: 128000, output: 16384 },
      },
      'o1': {
        id: 'o1',
        modalities: { input: ['text'], output: ['text'] },
        reasoning: true,
        tool_call: true,
        limit: { context: 200000, output: 100000 },
      },
    },
  },
  zhipuai: {
    id: 'zhipuai',
    models: {
      'glm-5': {
        id: 'glm-5',
        modalities: { input: ['text'], output: ['text'] },
        reasoning: true,
        tool_call: true,
        limit: { context: 204800, output: 131072 },
      },
    },
  },
});

describe('parseModelsDevCapabilities', () => {
  it('maps modalities to vision/pdf/audio/video flags', () => {
    const parsed = parseModelsDevCapabilities(SAMPLE_PAYLOAD);
    expect(parsed).not.toBeNull();
    const gpt4o = parsed!.get('gpt-4o')!;
    expect(gpt4o.vision).toBe(true);
    expect(gpt4o.pdf).toBe(false);
    expect(gpt4o.audioInput).toBe(false);
    expect(gpt4o.videoInput).toBe(false);
    expect(gpt4o.imageOutput).toBe(false);
    expect(gpt4o.audioOutput).toBe(false);
  });

  it('maps reasoning, tool_call and limit fields', () => {
    const parsed = parseModelsDevCapabilities(SAMPLE_PAYLOAD)!;
    const o1 = parsed.get('o1')!;
    expect(o1.reasoning).toBe(true);
    expect(o1.tools).toBe(true);
    expect(o1.contextWindow).toBe(200_000);
    expect(o1.maxOutput).toBe(100_000);

    const glm5 = parsed.get('glm-5')!;
    expect(glm5.reasoning).toBe(true);
    expect(glm5.contextWindow).toBe(204_800);
    expect(glm5.maxOutput).toBe(131_072);
  });

  it('fills missing fields from the default floor instead of leaving gaps', () => {
    const parsed = parseModelsDevCapabilities(SAMPLE_PAYLOAD)!;
    const gpt4o = parsed.get('gpt-4o')!;
    // modalities present, reasoning missing -> floor false, not undefined
    expect(gpt4o.reasoning).toBe(false);
    expect(gpt4o.contextWindow).toBe(128_000); // from limit
    expect(gpt4o.maxOutput).toBe(16_384); // from limit
  });

  it('normalizes model ids the same way as the price table', () => {
    const payload = JSON.stringify({
      acme: { id: 'acme', models: { 'GLM-5:free': { modalities: { input: ['text'], output: ['text'] } } } },
    });
    const parsed = parseModelsDevCapabilities(payload)!;
    expect(parsed.has('glm-5')).toBe(true);
  });

  it('returns null for invalid payloads', () => {
    expect(parseModelsDevCapabilities('not json')).toBeNull();
    expect(parseModelsDevCapabilities('"[]"')).toBeNull();
    expect(parseModelsDevCapabilities('{}')).not.toBeNull();
    expect(parseModelsDevCapabilities(JSON.stringify({ p: { models: {} } }))!.size).toBe(0);
  });
});

describe('lookupModelsDevCapabilities', () => {
  beforeEach(() => {
    const parsed = parseModelsDevCapabilities(SAMPLE_PAYLOAD)!;
    __setModelsDevCapabilitiesForTests(parsed);
  });

  it('returns exact-id capabilities', () => {
    const caps = lookupModelsDevCapabilities('gpt-4o');
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(false);
  });

  it('falls back to date-stripped id', () => {
    const caps = lookupModelsDevCapabilities('gpt-4o-2024-08-06');
    expect(caps.vision).toBe(true);
    expect(caps.contextWindow).toBe(128_000);
  });

  it('returns the DEFAULT floor for unknown models (never null)', () => {
    const caps = lookupModelsDevCapabilities('some-future-model-v9');
    expect(caps).toEqual(DEFAULT_CAPABILITIES);
    expect(caps.tools).toBe(true);
    expect(caps.reasoning).toBe(false);
  });

  it('handles empty input defensively', () => {
    expect(lookupModelsDevCapabilities('')).toEqual(DEFAULT_CAPABILITIES);
    expect(lookupModelsDevCapabilities('   ')).toEqual(DEFAULT_CAPABILITIES);
  });
});

describe('default floor sanity', () => {
  it('DEFAULT_CAPABILITIES is a complete record', () => {
    const required: (keyof ModelsDevCapabilities)[] = [
      'vision', 'pdf', 'audioInput', 'videoInput',
      'imageOutput', 'audioOutput', 'search', 'tools',
      'reasoning', 'contextWindow', 'maxOutput',
    ];
    for (const key of required) {
      expect(DEFAULT_CAPABILITIES[key]).toBeDefined();
    }
  });
});
