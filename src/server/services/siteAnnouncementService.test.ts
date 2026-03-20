import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getAdapterMock = vi.fn();
const sendNotificationMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapterMock(...args),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./siteAnnouncementService.js');

describe('siteAnnouncementService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let syncSiteAnnouncements: ServiceModule['syncSiteAnnouncements'];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-announcements-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./siteAnnouncementService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    syncSiteAnnouncements = serviceModule.syncSiteAnnouncements;
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    getAdapterMock.mockReset();
    sendNotificationMock.mockReset();

    await db.delete(schema.siteAnnouncements).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    vi.useRealTimers();
    if (typeof closeDbConnections === 'function') {
      await closeDbConnections();
    }
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  it('stores first-seen announcements, creates one event, and sends one notification', async () => {
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));

    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'demo-user',
      accessToken: 'jwt-token',
      status: 'active',
    }).run();
    await db.insert(schema.sites).values({
      name: 'Unsupported Site',
      url: 'https://unsupported.example.com',
      platform: 'openai',
      status: 'active',
    }).run();

    getAdapterMock.mockImplementation((platform: string) => {
      if (platform === 'sub2api') {
        return {
          getSiteAnnouncements: vi.fn(async (_baseUrl: string, accessToken: string) => {
            expect(accessToken).toBe('jwt-token');
            return [{
              sourceKey: 'announcement:11',
              title: 'Maintenance',
              content: 'Window starts at 10:00',
              level: 'info',
              rawPayload: { id: 11, title: 'Maintenance' },
            }];
          }),
        };
      }
      return {
        getSiteAnnouncements: undefined,
      };
    });

    const result = await syncSiteAnnouncements();

    expect(result).toMatchObject({
      scannedSites: 2,
      inserted: 1,
      updated: 0,
      unsupported: 1,
      notifications: 1,
      events: 1,
      failed: 0,
    });

    const announcementRows = await db.select().from(schema.siteAnnouncements).all();
    expect(announcementRows).toHaveLength(1);
    expect(announcementRows[0]).toMatchObject({
      siteId: site.id,
      platform: 'sub2api',
      sourceKey: 'announcement:11',
      title: 'Maintenance',
      content: 'Window starts at 10:00',
      level: 'info',
    });

    const eventRows = await db.select().from(schema.events).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      type: 'site_notice',
      relatedType: 'site_announcement',
    });
    expect(Number(eventRows[0]?.relatedId)).toBe(Number(announcementRows[0]?.id));

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0]?.[0]).toContain('Sub Site');
    expect(sendNotificationMock.mock.calls[0]?.[1]).toContain('Window starts at 10:00');
    expect(sendNotificationMock.mock.calls[0]?.[2]).toBe('info');
  });

  it('updates existing announcements without duplicating events or notifications', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'demo-user',
      accessToken: 'jwt-token',
      status: 'active',
    }).run();

    getAdapterMock.mockReturnValue({
      getSiteAnnouncements: vi.fn(async () => [{
        sourceKey: 'announcement:11',
        title: 'Maintenance',
        content: 'Window starts at 10:00',
        level: 'info',
        rawPayload: { id: 11, title: 'Maintenance' },
      }]),
    });

    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    await syncSiteAnnouncements({ siteId: site.id });
    const firstRow = await db.select().from(schema.siteAnnouncements).get();

    vi.setSystemTime(new Date('2026-03-20T11:00:00Z'));
    const result = await syncSiteAnnouncements({ siteId: site.id });

    expect(result).toMatchObject({
      scannedSites: 1,
      inserted: 0,
      updated: 1,
      notifications: 0,
      events: 0,
      failed: 0,
    });

    const announcementRows = await db.select().from(schema.siteAnnouncements).all();
    expect(announcementRows).toHaveLength(1);
    expect(announcementRows[0]?.firstSeenAt).toBe(firstRow?.firstSeenAt);
    expect(announcementRows[0]?.lastSeenAt).not.toBe(firstRow?.lastSeenAt);

    const eventRows = await db.select().from(schema.events).all();
    expect(eventRows).toHaveLength(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
