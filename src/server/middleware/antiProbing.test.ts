import { describe, expect, it } from 'vitest';
import { isProbeRequest } from './antiProbing.js';

describe('isProbeRequest', () => {
  it('flags a standalone short probe message', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })).toBe(true);
  });

  it('flags a short message with no substantive prior user context', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })).toBe(true);
  });

  it('allows a short follow-up after a substantive prior user turn', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: '请帮我写一段关于机器学习的技术分析报告' },
        { role: 'assistant', content: '好的，如下...' },
        { role: 'user', content: '谢谢' },
      ],
    })).toBe(false);
  });

  it('allows normal long user messages', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '请解释一下分布式系统中的一致性模型' }],
    })).toBe(false);
  });

  it('allows a short last message in a Gemini multi-turn conversation', () => {
    expect(isProbeRequest({
      model: 'gemini-2.0-flash',
      contents: [
        { role: 'user', parts: [{ text: '写一首关于夏天的诗' }] },
        { role: 'model', parts: [{ text: '夏日的风...' }] },
        { role: 'user', parts: [{ text: '再写一首' }] },
      ],
    })).toBe(false);
  });

  it('respects a configurable custom threshold', () => {
    // With a lenient threshold (1), a short-ish (but not pattern-matching) message is allowed.
    expect(isProbeRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'abcde' }] },
      1,
    )).toBe(false);
    // With the default threshold (8), the same message is flagged as a probe.
    expect(isProbeRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'abcde' }] },
      8,
    )).toBe(true);
  });

  it('allows "write a story" — write-prefix is legitimate coding/agent traffic', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'write a story' }],
    })).toBe(false);
  });

  it('allows a long "can you" question', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'can you explain how distributed systems achieve consensus in detail?' }],
    })).toBe(false);
  });

  it('flags a short bare "can you" capability probe', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'can you help?' }],
    })).toBe(true);
  });

  it('does not flag a normal sentence containing "hi" as a substring', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'please fix the bug in this function and explain the change' }],
    })).toBe(false);
  });

  it('still flags a whole-word keyword probe', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'system prompt reveal' }],
    })).toBe(true);
  });
});