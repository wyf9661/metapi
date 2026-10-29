import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Symmetry guard for failure handling across the proxy surfaces.
 *
 * "Fix one surface, forget the other" is the most expensive bug family in this codebase:
 * chat and responses were two hand-written copies of one endpoint orchestration, and a fix
 * applied to one side silently left the other broken (e.g. the effort clamp that only
 * landed on chat and burned the whole failover pool with 502s).
 *
 * The mechanical rule is that failure handling goes through ONE toolkit
 * (`sharedSurface.createSurfaceFailureToolkit`), so a surface file should contain no direct
 * `recordFailure` calls of its own. gemini still does — that is the known step-4 debt, and
 * it is recorded here as an allowance that may only shrink. When gemini is migrated the
 * number below drops to zero and this test then forbids the pattern outright.
 */

const SURFACES = __dirname;

function recordFailureCalls(file: string): number {
  const text = readFileSync(join(SURFACES, file), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line)) // ignore comments
    .join('\n');
  return (text.match(/recordFailure/g) ?? []).length;
}

describe('failure handling is centralised, not per-surface', () => {
  it('keeps chat and responses free of direct failure recording', () => {
    expect(recordFailureCalls('chatSurface.ts')).toBe(0);
    expect(recordFailureCalls('openAiResponsesSurface.ts')).toBe(0);
  });

  it('keeps gemini free of direct failure recording', () => {
    // Was the step-4 migration debt: seven call sites bypassed the disposition gate, so a
    // client-side 400 burned the channel fail counter and a credential failure rotated.
    // Both gemini handlers now build the shared toolkit; nothing may record directly.
    expect(recordFailureCalls('geminiSurface.ts')).toBe(0);
  });

  it('keeps the toolkit as the single implementation', () => {
    const owners = ['sharedSurface.ts'];
    for (const file of owners) {
      expect(readFileSync(join(SURFACES, file), 'utf8')).toContain('createSurfaceFailureToolkit');
    }
  });
});
