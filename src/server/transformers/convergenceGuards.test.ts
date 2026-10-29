import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Structural guards for the 2026-10-29 convergence work.
 *
 * Each assertion pins a property that used to be violated and cost multiple production
 * bugs. They are deliberately narrow: they name the ONE implementation that must exist and
 * the duplicates that must not come back. They are not a general architecture linter —
 * that is `architecture-boundaries.test.ts`'s job — so a new, legitimate refactor that
 * moves code should update this file consciously rather than silently regress.
 */

const TRANSFORMERS = __dirname;
const SERVER_ROOT = join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const sources = walk(TRANSFORMERS);

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

describe('one tool-call index implementation', () => {
  it('resolves indices only in shared/toolCallIndex.ts', () => {
    const owners = sources.filter((file) => /export function resolveToolCallIndex/.test(read(file)));
    expect(owners.map((f) => relative(TRANSFORMERS, f))).toEqual([join('shared', 'toolCallIndex.ts')]);
  });

  it('never falls back to the array position for a missing tool-call index', () => {
    // The original production bug: numbering argument fragments 0..n by their position in
    // the `tool_calls` array split one call into n unparseable "parallel" calls.
    const offenders = sources.filter((file) => {
      const text = read(file);
      return /itemIndex\s*\)?/.test(text) && !file.endsWith('toolCallIndex.ts');
    });
    expect(offenders.map((f) => relative(TRANSFORMERS, f))).toEqual([]);
  });
});

describe('one finish-reason vocabulary', () => {
  it('keeps the canonical table in shared/finishReason.ts only', () => {
    const tables = sources.filter((file) => /const FINISH_REASON_TABLE/.test(read(file)));
    expect(tables.map((f) => relative(TRANSFORMERS, f))).toEqual([join('shared', 'finishReason.ts')]);
  });

  it('has no substring-based finish-reason matching left', () => {
    // `includes('max')` read `max_tool_calls` as length; `includes('tool')` read `nomatch`
    // as tool_calls. Exact table lookups only.
    const offenders = sources.filter((file) => {
      // Strip comments: the owner's doc explains the old bug by quoting the pattern.
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      return /value\.includes\('(max|tool)'\)/.test(code);
    });
    expect(offenders.map((f) => relative(TRANSFORMERS, f))).toEqual([]);
  });
});

describe('one failure policy', () => {
  it('keeps the unused conductor implementation deleted', () => {
    // 560 lines of a third "what to do on failure" policy, zero references. Its presence
    // meant every new failure semantic had three candidate homes.
    expect(existsSync(join(SERVER_ROOT, 'proxy-core', 'conductor'))).toBe(false);
  });
});
