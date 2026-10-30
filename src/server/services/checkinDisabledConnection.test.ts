import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A disabled connection only leaves routing; it must keep checking in on
// schedule (user: "禁用之后我希望自动签到里仍然继续"). Guard both the bulk
// pass and the interval scheduler against re-adding the status filter.
describe('check-in ignores the connection status', () => {
  it('bulk check-in selects accounts by checkinEnabled only', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/server/services/checkinService.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function checkinAll');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 800);

    expect(body).toContain('.where(eq(schema.accounts.checkinEnabled, true))');
    expect(body).not.toContain("eq(schema.accounts.status, 'active')");
  });

  it('interval scheduler does not filter on the connection status', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/server/services/checkinScheduler.ts'),
      'utf8',
    );
    const start = source.indexOf('.filter((row: any) => row.accounts?.checkinEnabled');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, start + 400);

    expect(body).toContain("row.accounts?.checkinEnabled === true");
    expect(body).toContain("row.sites?.status !== 'disabled'");
    expect(body).not.toContain("row.accounts?.status === 'active'");
  });
});
