import { describe, expect, it } from 'vitest';
import {
  classifyTokenValue,
  locateTokenInKeys,
  isClassifiableTokenKey,
} from './tokenMask.js';

describe('classifyTokenValue — plaintext comparison', () => {
  it('matches identical plaintext', () => {
    expect(classifyTokenValue('sk-abc', 'sk-abc')).toBe('match');
  });

  it('mismatches different plaintext', () => {
    expect(classifyTokenValue('sk-abc', 'sk-def')).toBe('mismatch');
  });

  it('treats empty side as unknown', () => {
    expect(classifyTokenValue('', 'sk-abc')).toBe('unknown');
    expect(classifyTokenValue(null, undefined)).toBe('unknown');
  });
});

describe('classifyTokenValue — masked comparison', () => {
  it('matches a masked key against its own plaintext via visible prefix+suffix', () => {
    expect(classifyTokenValue('sk-lDon12345678gPZG', 'sk-lDon**********gPZG')).toBe('match');
  });

  it('matches despite mask format drift (different suffix length)', () => {
    expect(classifyTokenValue('sk-lDon12345678gPZG', 'sk-lDon*******gPZG')).toBe('match');
  });

  it('matches a bullet-masked key whose visible prefix and suffix fit the plaintext', () => {
    expect(classifyTokenValue('sk-lDon12345678gPZG', 'sk-lDon•C•gPZG')).toBe('match');
  });

  it('returns unknown when the mask hides enough visible chars below the floor', () => {
    expect(classifyTokenValue('sk-12345xz', 'sk-ab***xz')).toBe('unknown');
  });

  it('returns unknown for a fully opaque mask', () => {
    expect(classifyTokenValue('sk-12345xz', 'sk-******')).toBe('unknown');
  });
});

describe('locateTokenInKeys', () => {
  it('returns index+present for a single unique match', () => {
    expect(locateTokenInKeys('sk-abc', ['sk-abc', 'sk-def'])).toEqual({ index: 0, absent: false, present: true });
  });

  it('is ambiguous (absent=false) when two upstream keys match a short mask', () => {
    expect(locateTokenInKeys('sk-ab12cd34ef', ['sk-ab1*cd34ef', 'sk-ab1*cd34ef'])).toEqual({ index: null, absent: false, present: false });
  });

  it('proves absence when no match and every key is classifiable', () => {
    expect(locateTokenInKeys('sk-aaa', ['sk-bbb', 'sk-ccc'])).toEqual({ index: null, absent: true, present: false });
  });

  it('fails closed (absent=false) when any key is unclassifiable', () => {
    expect(locateTokenInKeys('sk-aaa', ['sk-bbb', 'sk-short*'])).toEqual({ index: null, absent: false, present: false });
  });

  it('treats an empty upstream list as absent but unverifiable', () => {
    expect(locateTokenInKeys('sk-aaa', [])).toEqual({ index: null, absent: true, present: false });
  });
});

describe('isClassifiableTokenKey', () => {
  it('classifies plaintext', () => {
    expect(isClassifiableTokenKey('sk-abc')).toBe(true);
  });
  it('classifies a mask above the visible-char floor', () => {
    expect(isClassifiableTokenKey('sk-lDon**********gPZG')).toBe(true);
  });
  it('does not classify an opaque short mask', () => {
    expect(isClassifiableTokenKey('sk-ab***xz')).toBe(false);
  });
});