import { describe, expect, it } from 'vitest';
import { createEmptyPayloadRulesConfig, parsePayloadRulesConfigInput } from './payloadRules.js';

describe('parsePayloadRulesConfigInput', () => {
  it('accepts CPA-style dashed raw keys and normalizes them to camelCase sections', () => {
    const result = parsePayloadRulesConfigInput({
      override: [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: {
            'reasoning.effort': 'high',
          },
        },
      ],
      'override-raw': [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: {
            response_format: '{"type":"json_schema"}',
          },
        },
      ],
      filter: [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: ['safety_identifier'],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.normalized).toEqual({
      ...createEmptyPayloadRulesConfig(),
      override: [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: {
            'reasoning.effort': 'high',
          },
        },
      ],
      overrideRaw: [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: {
            response_format: '{"type":"json_schema"}',
          },
        },
      ],
      filter: [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: ['safety_identifier'],
        },
      ],
    });
  });

  it('rejects invalid raw JSON fragments', () => {
    const result = parsePayloadRulesConfigInput({
      'override-raw': [
        {
          models: [{ name: 'gpt-*', protocol: 'codex' }],
          params: {
            response_format: '{invalid-json',
          },
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      message: 'Payload 规则 override-raw 第 1 条的 response_format 不是合法 JSON',
    });
  });

  it('rejects unknown sections so the settings UI cannot silently save ignored data', () => {
    const result = parsePayloadRulesConfigInput({
      override: [],
      unexpected: [],
    });

    expect(result).toEqual({
      success: false,
      message: 'Payload 规则包含未知分组：unexpected',
    });
  });
});
