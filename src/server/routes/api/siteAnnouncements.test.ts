import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const syncSiteAnnouncementsMock = vi.fn();

vi.mock('../../services/siteAnnouncementService.js', () => ({
  syncSiteAnnouncements: (...args: unknown[]) => syncSiteAnnouncementsMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('site announcements routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'] | undefined;
  let getBackgroundTask: ((taskId: string) => { id: string; status: string } | null) | null = null;
  let resetBackgroundTasks: (() => void) | null = null;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-announcements-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./siteAnnouncements.js');
    const eventsModule = await import('./events.js');
    const backgroundTaskModule = await import('../../services/backgroundTaskService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    getBackgroundTask = backgroundTaskModule.getBackgroundTask;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;

    app = Fastify();
    await app.register(routesModule.siteAnnouncementsRoutes);
    await app.register(eventsModule.eventsRoutes);
  });

  beforeEach(async () => {
    syncSiteAnnouncementsMock.mockReset();
    resetBackgroundTasks?.();
    await db.delete(schema.siteAnnouncements).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
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

  it('lists announcements with site and unread filters', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
    }).returning().get();
    const otherSite = await db.insert(schema.sites).values({
      name: 'Other Site',
      url: 'https://other.example.com',
      platform: 'new-api',
    }).returning().get();

    await db.insert(schema.siteAnnouncements).values([
      {
        siteId: site.id,
        platform: 'sub2api',
        sourceKey: 'announcement:11',
        title: 'Maintenance',
        content: 'Window starts at 10:00',
        level: 'info',
        firstSeenAt: '2026-03-20 10:00:00',
        lastSeenAt: '2026-03-20 10:00:00',
      },
      {
        siteId: otherSite.id,
        platform: 'new-api',
        sourceKey: 'announcement:12',
        title: 'Other',
        content: 'Other notice',
        level: 'info',
        firstSeenAt: '2026-03-20 09:00:00',
        lastSeenAt: '2026-03-20 09:00:00',
        readAt: '2026-03-20 09:05:00',
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: `/api/site-announcements?siteId=${site.id}&read=false`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ siteId: number; sourceKey: string }>;
    expect(body).toEqual([
      expect.objectContaining({
        siteId: site.id,
        sourceKey: 'announcement:11',
      }),
    ]);
  });

  it('marks one announcement as read and then marks all as read', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
    }).returning().get();
    const first = await db.insert(schema.siteAnnouncements).values({
      siteId: site.id,
      platform: 'sub2api',
      sourceKey: 'announcement:11',
      title: 'Maintenance',
      content: 'Window starts at 10:00',
      level: 'info',
      firstSeenAt: '2026-03-20 10:00:00',
      lastSeenAt: '2026-03-20 10:00:00',
    }).returning().get();
    await db.insert(schema.siteAnnouncements).values({
      siteId: site.id,
      platform: 'sub2api',
      sourceKey: 'announcement:12',
      title: 'Model online',
      content: 'gpt-4.1 is available',
      level: 'info',
      firstSeenAt: '2026-03-20 11:00:00',
      lastSeenAt: '2026-03-20 11:00:00',
    }).run();

    const singleRead = await app.inject({
      method: 'POST',
      url: `/api/site-announcements/${first.id}/read`,
    });
    expect(singleRead.statusCode).toBe(200);

    const afterSingle = await db.select().from(schema.siteAnnouncements).where(eq(schema.siteAnnouncements.id, first.id)).get();
    expect(afterSingle?.readAt).toBeTruthy();

    const bulkRead = await app.inject({
      method: 'POST',
      url: '/api/site-announcements/read-all',
    });
    expect(bulkRead.statusCode).toBe(200);

    const rows = await db.select().from(schema.siteAnnouncements).all();
    expect(rows.every((row) => typeof row.readAt === 'string' && row.readAt.length > 0)).toBe(true);
  });

  it('clears local announcement rows without touching program events', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
    }).returning().get();
    await db.insert(schema.siteAnnouncements).values({
      siteId: site.id,
      platform: 'sub2api',
      sourceKey: 'announcement:11',
      title: 'Maintenance',
      content: 'Window starts at 10:00',
      level: 'info',
      firstSeenAt: '2026-03-20 10:00:00',
      lastSeenAt: '2026-03-20 10:00:00',
    }).run();
    await db.insert(schema.events).values({
      type: 'site_notice',
      title: '站点公告：Sub Site',
      message: 'Window starts at 10:00',
      level: 'info',
      relatedId: 123,
      relatedType: 'site_announcement',
      createdAt: '2026-03-20 10:00:00',
    }).run();

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/site-announcements',
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(schema.siteAnnouncements).all()).toEqual([]);
    expect(await db.select().from(schema.events).all()).toHaveLength(1);
  });

  it('queues a background sync task and returns its task id', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
    }).returning().get();

    syncSiteAnnouncementsMock.mockImplementation(() => new Promise(() => {}));

    const response = await app.inject({
      method: 'POST',
      url: '/api/site-announcements/sync',
      payload: { siteId: site.id },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { taskId: string; queued: boolean };
    expect(body.queued).toBe(true);
    expect(typeof body.taskId).toBe('string');
    expect(getBackgroundTask?.(body.taskId)).toBeTruthy();
  });

  it('returns site_notice rows through the generic events api filter', async () => {
    await db.insert(schema.events).values({
      type: 'site_notice',
      title: '站点公告：Sub Site',
      message: 'Window starts at 10:00',
      level: 'info',
      relatedId: 1,
      relatedType: 'site',
      createdAt: '2026-03-20 10:00:00',
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/events?type=site_notice',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{ type: string }>;
    expect(body).toEqual([expect.objectContaining({ type: 'site_notice' })]);
  });
});
