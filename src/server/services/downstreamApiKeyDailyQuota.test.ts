import { describe, expect, it } from 'vitest';

// Lightweight pure checks for day-window formatting used by daily quota reset.
function currentDailyWindowDate(nowMs: number, timeZone = 'Asia/Shanghai'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

describe('daily window date', () => {
  it('formats stable YYYY-MM-DD in Asia/Shanghai', () => {
    // 2026-07-20 16:00 UTC = 2026-07-21 00:00 Asia/Shanghai
    const d = currentDailyWindowDate(Date.UTC(2026, 6, 20, 16, 0, 0), 'Asia/Shanghai');
    expect(d).toBe('2026-07-21');
  });

  it('stays previous local day just before midnight Shanghai', () => {
    // 2026-07-20 15:59 UTC = 2026-07-20 23:59 Asia/Shanghai
    const d = currentDailyWindowDate(Date.UTC(2026, 6, 20, 15, 59, 0), 'Asia/Shanghai');
    expect(d).toBe('2026-07-20');
  });
});
