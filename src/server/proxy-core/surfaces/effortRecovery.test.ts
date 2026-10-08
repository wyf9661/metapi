import { beforeEach, describe, expect, it } from 'vitest';
import {
  clampBuiltBodyToEffortCeiling,
  isEffortRejectionRetryable,
  recoverForEffortRejection,
} from './effortRecovery.js';
import {
  __resetReasoningEffortCeilingsForTests,
  recordReasoningEffortCeiling,
} from '../../services/siteReasoningEffortCapabilityService.js';

describe('isEffortRejectionRetryable', () => {
  it('is true only for a 400 that names the effort', () => {
    expect(isEffortRejectionRetryable(400, 'level "max" not supported, valid levels: low, medium, high')).toBe(true);
    expect(isEffortRejectionRetryable(400, 'reasoning_effort invalid')).toBe(true);
  });

  it('is false for non-400 statuses and unrelated 400s', () => {
    expect(isEffortRejectionRetryable(500, 'reasoning_effort invalid')).toBe(false);
    expect(isEffortRejectionRetryable(400, 'model is required')).toBe(false);
    expect(isEffortRejectionRetryable(400, null)).toBe(false);
  });
});

describe('recoverForEffortRejection', () => {
  beforeEach(() => {
    __resetReasoningEffortCeilingsForTests();
  });

  it('steps every source body one rung down on a ladder rejection', () => {
    const responsesBody = { reasoning: { effort: 'max' } };
    const openAiBody = { reasoning_effort: 'max' };

    const changed = recoverForEffortRejection({
      status: 400,
      errText: 'field ReasoningEffort invalid, should be one of: low, medium, high',
      siteId: 44,
      endpoint: 'responses',
      bodies: [responsesBody, openAiBody],
    });

    expect(changed).toBe(true);
    expect(responsesBody.reasoning.effort).toBe('xhigh');
    expect(openAiBody.reasoning_effort).toBe('xhigh');
  });

  it('teaches the ceiling from a listed ladder and applies it to every body', () => {
    const responsesBody = { reasoning: { effort: 'max' } };

    recoverForEffortRejection({
      status: 400,
      errText: 'level "max" not supported, valid levels: low, medium, high',
      siteId: 44,
      endpoint: 'responses',
      bodies: [responsesBody],
    });

    // One rung below the rejected value...
    expect(responsesBody.reasoning.effort).toBe('xhigh');
    // ...but the ceiling learned for this site+protocol is the top accepted rung.
    expect(clampBuiltBodyToEffortCeiling({ reasoning: { effort: 'max' } }, 44, 'responses')).toBe('high');
  });

  it('strips the effort field from every body when `none` is rejected', () => {
    const responsesBody = { reasoning: { effort: 'none' } };
    const openAiBody = { reasoning_effort: 'none' };

    const changed = recoverForEffortRejection({
      status: 400,
      errText: 'This model does not support `reasoning_effort` value `none`.',
      siteId: 44,
      endpoint: 'responses',
      bodies: [responsesBody, openAiBody],
    });

    expect(changed).toBe(true);
    expect(responsesBody.reasoning).toBeUndefined();
    expect(openAiBody.reasoning_effort).toBeUndefined();
  });

  it('handles the Anthropic output_config.effort shape', () => {
    const anthropicBody = { output_config: { effort: 'max' } };

    recoverForEffortRejection({
      status: 400,
      errText: 'reasoning effort "max" is not supported',
      siteId: 44,
      endpoint: 'messages',
      bodies: [anthropicBody],
    });

    expect(anthropicBody.output_config.effort).toBe('xhigh');
  });

  it('is a no-op for non-effort errors and when no body carries an effort', () => {
    const body = { reasoning_effort: 'max' };
    expect(recoverForEffortRejection({
      status: 400,
      errText: 'model is required',
      siteId: 44,
      endpoint: 'responses',
      bodies: [body],
    })).toBe(false);
    expect(body.reasoning_effort).toBe('max');

    expect(recoverForEffortRejection({
      status: 400,
      errText: 'reasoning_effort invalid',
      siteId: 44,
      endpoint: 'responses',
      bodies: [{ input: 'hi' }],
    })).toBe(false);
  });

  it('does not downgrade past the floor', () => {
    const body = { reasoning_effort: 'minimal' };
    expect(recoverForEffortRejection({
      status: 400,
      errText: 'reasoning_effort invalid',
      siteId: 44,
      endpoint: 'responses',
      bodies: [body],
    })).toBe(false);
    expect(body.reasoning_effort).toBe('minimal');
  });
});

describe('clampBuiltBodyToEffortCeiling', () => {
  beforeEach(() => {
    __resetReasoningEffortCeilingsForTests();
  });

  it('leaves a body alone when no ceiling was learned for the site', () => {
    const body = { reasoning: { effort: 'max' } };
    expect(clampBuiltBodyToEffortCeiling(body, 999, 'responses')).toBeNull();
    expect(body.reasoning.effort).toBe('max');
  });

  it('caps a body above a learned ceiling', () => {
    recordReasoningEffortCeiling({ siteId: 44, endpoint: 'responses', maxEffort: 'high' });
    const body = { reasoning: { effort: 'max' } };
    expect(clampBuiltBodyToEffortCeiling(body, 44, 'responses')).toBe('high');
    expect(body.reasoning.effort).toBe('high');
  });

  it('keeps ceilings independent per protocol', () => {
    recordReasoningEffortCeiling({ siteId: 44, endpoint: 'chat', maxEffort: 'high' });
    const responsesBody = { reasoning: { effort: 'max' } };
    expect(clampBuiltBodyToEffortCeiling(responsesBody, 44, 'responses')).toBeNull();
    expect(responsesBody.reasoning.effort).toBe('max');
  });
});
