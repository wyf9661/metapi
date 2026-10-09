import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The refresh icons render mirrored: scaleX(-1) is baked into every
// spin-mirrored keyframe so mirror+rotation stay on ONE transform channel
// (the two-channel version wobbled around a shifted origin on desktop).
// A horizontal mirror reverses the visual handedness of a rotation, so the
// sweep must run NEGATIVE (0 -> -360deg) to read CLOCKWISE on screen; a
// positive sweep reads counter-clockwise (the "spin direction reversed"
// regression). Applies to the Dashboard / ProxyLogs refresh icons.
describe('refresh icon spin direction', () => {
  it('spin-mirrored sweeps negative angles so the mirrored icon spins clockwise', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    const start = css.indexOf('@keyframes spin-mirrored');
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf('@keyframes', start + '@keyframes spin-mirrored'.length);
    const block = css.slice(start, end === -1 ? undefined : end);
    expect(block).toContain('scaleX(-1) rotate(0deg)');
    expect(block).toContain('scaleX(-1) rotate(-360deg)');
  });
});
