import { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { syncSiteAnnouncements } from '../../services/siteAnnouncementService.js';

type SiteAnnouncementRow = typeof schema.siteAnnouncements.$inferSelect;

function parseTimeValue(input?: string | null): number | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  return Number.isFinite(parsed) ? parsed : null;
}

function applyReadFilter(rows: SiteAnnouncementRow[], read?: string): SiteAnnouncementRow[] {
  if (read === 'true') {
    return rows.filter((row) => typeof row.readAt === 'string' && row.readAt.length > 0);
  }
  if (read === 'false') {
    return rows.filter((row) => !row.readAt);
  }
  return rows;
}

function applyStatusFilter(rows: SiteAnnouncementRow[], status?: string): SiteAnnouncementRow[] {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return rows;
  const now = Date.now();
  if (normalized === 'dismissed') {
    return rows.filter((row) => typeof row.dismissedAt === 'string' && row.dismissedAt.length > 0);
  }
  if (normalized === 'expired') {
    return rows.filter((row) => !row.dismissedAt && (() => {
      const endsAt = parseTimeValue(row.endsAt);
      return endsAt !== null && endsAt < now;
    })());
  }
  if (normalized === 'active') {
    return rows.filter((row) => !row.dismissedAt && (() => {
      const endsAt = parseTimeValue(row.endsAt);
      return endsAt === null || endsAt >= now;
    })());
  }
  return rows;
}

export async function siteAnnouncementsRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      siteId?: string;
      platform?: string;
      read?: string;
      status?: string;
    };
  }>('/api/site-announcements', async (request) => {
    const limit = Math.max(1, Math.min(500, Number.parseInt(request.query.limit || '50', 10)));
    const offset = Math.max(0, Number.parseInt(request.query.offset || '0', 10));
    const filters: any[] = [];

    const siteId = Number.parseInt(String(request.query.siteId || ''), 10);
    if (Number.isFinite(siteId) && siteId > 0) {
      filters.push(eq(schema.siteAnnouncements.siteId, siteId));
    }

    const platform = String(request.query.platform || '').trim();
    if (platform) {
      filters.push(eq(schema.siteAnnouncements.platform, platform));
    }

    const base = db.select().from(schema.siteAnnouncements);
    const rows = filters.length > 0
      ? await base.where(and(...filters)).orderBy(desc(schema.siteAnnouncements.firstSeenAt)).all()
      : await base.orderBy(desc(schema.siteAnnouncements.firstSeenAt)).all();

    const filtered = applyStatusFilter(applyReadFilter(rows, request.query.read), request.query.status);
    return filtered.slice(offset, offset + limit);
  });

  app.post<{ Params: { id: string } }>('/api/site-announcements/:id/read', async (request) => {
    const id = Number.parseInt(request.params.id, 10);
    const readAt = formatUtcSqlDateTime(new Date());
    await db.update(schema.siteAnnouncements)
      .set({ readAt })
      .where(eq(schema.siteAnnouncements.id, id))
      .run();
    return { success: true };
  });

  app.post('/api/site-announcements/read-all', async () => {
    const readAt = formatUtcSqlDateTime(new Date());
    await db.update(schema.siteAnnouncements)
      .set({ readAt })
      .run();
    return { success: true };
  });

  app.delete('/api/site-announcements', async () => {
    await db.delete(schema.siteAnnouncements).run();
    return { success: true };
  });

  app.post<{ Body: { siteId?: number | string | null } }>('/api/site-announcements/sync', async (request) => {
    const parsedSiteId = Number.parseInt(String(request.body?.siteId ?? ''), 10);
    const siteId = Number.isFinite(parsedSiteId) && parsedSiteId > 0 ? parsedSiteId : null;
    const { task, reused } = startBackgroundTask(
      {
        type: 'site-announcements-sync',
        title: siteId ? `同步站点公告 #${siteId}` : '同步站点公告',
        dedupeKey: siteId ? `site-announcements:${siteId}` : 'site-announcements:all',
        notifyOnSuccess: false,
        notifyOnFailure: false,
      },
      () => syncSiteAnnouncements(siteId ? { siteId } : undefined),
    );

    return {
      success: true,
      queued: true,
      reused,
      taskId: task.id,
    };
  });
}
