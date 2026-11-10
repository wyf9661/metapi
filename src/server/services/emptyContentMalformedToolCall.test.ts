import { describe, expect, it } from 'vitest';

import { isEmptyContentFailureText } from './siteFailureClassification.js';

describe('isEmptyContentFailureText malformed tool calls', () => {
  it('classifies malformed tool call arguments as a channel-level failure text', () => {
    expect(isEmptyContentFailureText('Upstream returned malformed tool call arguments')).toBe(true);
    expect(isEmptyContentFailureText('Upstream returned empty content')).toBe(true);
    expect(isEmptyContentFailureText('bad gateway')).toBe(false);
  });
});
