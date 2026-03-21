import { describe, expect, it } from 'vitest';
import {
  BasePlatformAdapter,
  type BalanceInfo,
  type CheckinResult,
  type PlatformAdapter,
  type SiteAnnouncement,
} from './base.js';

class UnsupportedAnnouncementAdapter extends BasePlatformAdapter {
  override readonly platformName = 'unsupported';

  override async detect(): Promise<boolean> {
    return false;
  }

  override async checkin(): Promise<CheckinResult> {
    return { success: false, message: 'unsupported' };
  }

  override async getBalance(): Promise<BalanceInfo> {
    return { balance: 0, used: 0, quota: 0 };
  }

  override async getModels(): Promise<string[]> {
    return [];
  }
}

class SingleNoticeAdapter extends UnsupportedAnnouncementAdapter {
  override readonly platformName = 'single-notice';

  override async getSiteAnnouncements(): Promise<SiteAnnouncement[]> {
    return [{
      sourceKey: 'notice:welcome',
      title: 'Site notice',
      content: 'Welcome to the site',
      level: 'info',
      sourceUrl: '/api/notice',
      rawPayload: { notice: 'Welcome to the site' },
    }];
  }
}

class ListAnnouncementAdapter extends UnsupportedAnnouncementAdapter {
  override readonly platformName = 'list-notice';

  override async getSiteAnnouncements(): Promise<SiteAnnouncement[]> {
    return [
      {
        sourceKey: 'announcement:1',
        title: 'Maintenance',
        content: 'Window starts at 10:00',
        level: 'warning',
        startsAt: '2026-03-20T10:00:00Z',
        upstreamCreatedAt: '2026-03-20T09:00:00Z',
        rawPayload: { id: 1 },
      },
      {
        sourceKey: 'announcement:2',
        title: 'New model online',
        content: 'gpt-4.1 is available',
        level: 'info',
        endsAt: '2026-03-21T00:00:00Z',
        upstreamUpdatedAt: '2026-03-20T12:00:00Z',
        rawPayload: { id: 2 },
      },
    ];
  }
}

function expectAnnouncementShape(row: SiteAnnouncement) {
  expect(row.sourceKey).toBeTruthy();
  expect(row.title).toBeTruthy();
  expect(row.content).toBeTruthy();
  expect(['info', 'warning', 'error']).toContain(row.level);
}

describe('site announcement platform contract', () => {
  it('allows unsupported adapters to return an empty list', async () => {
    const adapter: PlatformAdapter = new UnsupportedAnnouncementAdapter();

    await expect(adapter.getSiteAnnouncements('https://example.com', 'token')).resolves.toEqual([]);
  });

  it('normalizes single-notice platforms into the shared announcement shape', async () => {
    const adapter: PlatformAdapter = new SingleNoticeAdapter();

    const rows = await adapter.getSiteAnnouncements('https://example.com', 'token');

    expect(rows).toHaveLength(1);
    expectAnnouncementShape(rows[0]);
  });

  it('normalizes list-style platforms into the shared announcement shape', async () => {
    const adapter: PlatformAdapter = new ListAnnouncementAdapter();

    const rows = await adapter.getSiteAnnouncements('https://example.com', 'token');

    expect(rows).toHaveLength(2);
    rows.forEach(expectAnnouncementShape);
  });
});
