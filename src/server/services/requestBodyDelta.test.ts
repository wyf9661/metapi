import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  REQUEST_BODY_DELTA_BASE_HEADER,
  REQUEST_BODY_DELTA_CAPABILITY_HEADER,
  REQUEST_BODY_DELTA_PREFIX_HEADER,
  REQUEST_BODY_DELTA_SHA256_HEADER,
  REQUEST_BODY_DELTA_MIN_BYTES,
  __getRequestBodyDeltaStatsForTests,
  __resetRequestBodyDeltaForTests,
  buildDeltaRequestBody,
  commonPrefixLength,
  learnUpstreamRequestBodyDeltaCapability,
  rememberSentRequestBody,
  supportsRequestBodyDelta,
} from './requestBodyDelta.js';

const ORIGIN = 'https://peer.example';
const AUTH = { authorization: 'Bearer sk-test' };

function learn(origin = ORIGIN): void {
  learnUpstreamRequestBodyDeltaCapability(origin, {
    headers: { get: (name) => (name === REQUEST_BODY_DELTA_CAPABILITY_HEADER ? 'v1' : null) },
  });
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('request body delta (sender)', () => {
  beforeEach(() => {
    __resetRequestBodyDeltaForTests();
  });

  it('stays inert until the peer advertises the capability', () => {
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(200_000) }] });
    expect(buildDeltaRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: body })).toBeNull();
    expect(supportsRequestBodyDelta(ORIGIN)).toBe(false);

    learn();
    expect(supportsRequestBodyDelta(ORIGIN)).toBe(true);
    // Capability alone is not a base: the first body still travels whole.
    expect(buildDeltaRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: body })).toBeNull();
  });

  it('sends only the appended suffix once a base is known', () => {
    learn();
    const messages = [{ role: 'user', content: 'y'.repeat(200_000) }];
    const first = JSON.stringify({ model: 'm', messages });
    rememberSentRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: first });

    const grown = JSON.stringify({
      model: 'm',
      messages: [...messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }],
    });
    const delta = buildDeltaRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: grown });

    expect(delta).not.toBeNull();
    const prefix = Number(delta!.headers[REQUEST_BODY_DELTA_PREFIX_HEADER]);
    expect(prefix).toBeGreaterThan(200_000);
    expect(Buffer.byteLength(delta!.bodyText)).toBeLessThan(Buffer.byteLength(grown) / 10);
    expect(delta!.headers[REQUEST_BODY_DELTA_SHA256_HEADER]).toBe(sha(grown));
    expect(delta!.headers[REQUEST_BODY_DELTA_BASE_HEADER]).toBe(sha(first));
    // The receiver rebuilds this exact body from base[0..prefix] + suffix.
    expect(first.slice(0, prefix) + delta!.bodyText).toBe(grown);
  });

  it('does not split a multi-byte character at the prefix boundary', () => {
    learn();
    const base = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: '中'.repeat(80_000) }] });
    rememberSentRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: base });
    // 中 (e4 b8 ad) and 串 (e4 b8 b2) share two bytes: the first differing byte
    // lands inside a character, so the prefix must back off to a boundary.
    const grown = JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: '中'.repeat(60_000) + '串'.repeat(20_000) }],
    });

    const delta = buildDeltaRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: grown });
    expect(delta).not.toBeNull();
    const prefix = Number(delta!.headers[REQUEST_BODY_DELTA_PREFIX_HEADER]);
    expect(Buffer.from(base).subarray(0, prefix).toString() + delta!.bodyText).toBe(grown);
    // No replacement characters: the suffix starts and ends on character boundaries.
    expect(delta!.bodyText).not.toContain('\ufffd');
  });

  it('falls back to a full body when the shared prefix is too short', () => {
    learn();
    const base = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'a'.repeat(200_000) }] });
    rememberSentRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: base });
    const unrelated = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'b'.repeat(200_000) }] });
    expect(buildDeltaRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: unrelated })).toBeNull();
  });

  it('scopes the base to the downstream credential', () => {
    learn();
    const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'z'.repeat(200_000) }] });
    rememberSentRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: body });
    expect(__getRequestBodyDeltaStatsForTests().senderEntries).toBe(1);
    const otherTenant = buildDeltaRequestBody({
      origin: ORIGIN,
      headers: { authorization: 'Bearer sk-other' },
      bodyText: body + 'x',
    });
    expect(otherTenant).toBeNull();
  });

  it('ignores bodies below the delta threshold', () => {
    learn();
    const body = JSON.stringify({ model: 'm', input: 'small' });
    expect(Buffer.byteLength(body)).toBeLessThan(REQUEST_BODY_DELTA_MIN_BYTES);
    rememberSentRequestBody({ origin: ORIGIN, headers: AUTH, bodyText: body });
    expect(__getRequestBodyDeltaStatsForTests().senderEntries).toBe(0);
  });

  it('measures the common prefix in bytes', () => {
    expect(commonPrefixLength(Buffer.from('abcdef'), Buffer.from('abcxyz'))).toBe(3);
    expect(commonPrefixLength(Buffer.from('abc'), Buffer.from('abcdef'))).toBe(3);
    expect(commonPrefixLength(Buffer.alloc(0), Buffer.from('abc'))).toBe(0);
  });
});
