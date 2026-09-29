import { describe, expect, it } from 'vitest';
import {
  parseAcceptedEffortLadderFromError,
  resolveInPlaceEffortRetryCeiling,
} from './reasoningEffort.js';

describe('parseAcceptedEffortLadderFromError', () => {
  it('parses the accepted rungs out of a valid-levels rejection', () => {
    expect(parseAcceptedEffortLadderFromError(
      'Upstream returned HTTP 400: level "max" not supported, valid levels: low, medium, high',
    )).toEqual(['low', 'medium', 'high']);
  });

  it('returns null for rejections that do not list a ladder', () => {
    expect(parseAcceptedEffortLadderFromError(
      'field ReasoningEffort invalid, should be one of: minimal, high',
    )).toBeNull();
    expect(parseAcceptedEffortLadderFromError('bad request')).toBeNull();
    expect(parseAcceptedEffortLadderFromError(null)).toBeNull();
  });

  it('ignores unknown spellings inside the listed ladder', () => {
    expect(parseAcceptedEffortLadderFromError(
      'level "max" not supported, valid levels: low, ultra, high',
    )).toEqual(['low', 'high']);
  });
});

describe('resolveInPlaceEffortRetryCeiling', () => {
  it('prefers the ladder parsed from the error over the mechanical step-down', () => {
    expect(resolveInPlaceEffortRetryCeiling({
      rejectedEffort: 'max',
      errorText: 'level "max" not supported, valid levels: low, medium, high',
    })).toBe('high');
  });

  it('falls back to one rung below the rejected value without a parsable ladder', () => {
    expect(resolveInPlaceEffortRetryCeiling({
      rejectedEffort: 'max',
      errorText: 'field ReasoningEffort invalid, should be one of: low',
    })).toBe('xhigh');
  });

  it('returns null when the rejected value is already at the floor', () => {
    expect(resolveInPlaceEffortRetryCeiling({
      rejectedEffort: 'minimal',
      errorText: 'level "minimal" not supported, valid levels: low, medium, high',
    })).toBeNull();
  });
});
