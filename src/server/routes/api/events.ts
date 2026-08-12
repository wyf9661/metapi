import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { normalizePageOffset, normalizePageSize } from './paginationNormalizers.js';

export async function eventsRoutes(app: FastifyInstance) {
  // List events
  app.get<{ Querystring: { limit?: string; offset?: string; type?: string; read?: string } }>('/api/events', async (request) => {
    const limit = normalizePageSize(request.query.limit, 30, 500);
    const offset = normalizePageOffset(request.query.offset);
    const type = request.query.type;
    const readQuery = request.query.read;

    const filters: any[] = [];
    if (type) filters.push(eq(schema.events.type, type));
    if (readQuery === 'true') filters.push(eq(schema.events.read, true));
    if (readQuery === 'false') filters.push(eq(schema.events.read, false));

    const base = db.select().from(schema.events);
    if (filters.length > 0) {
      return await base
        .where(and(...filters))
        .orderBy(desc(schema.events.createdAt))
        .limit(limit)
        .offset(offset)
        .all();
    }

    return await base
      .orderBy(desc(schema.events.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
  });

  // Unread count
  app.get('/api/events/count', async () => {
    const result = await db.select({ count: sql<number>`count(*)` }).from(schema.events)
      .where(eq(schema.events.read, false)).get();
    return { count: result?.count || 0 };
  });

  // Mark one as read
  app.post<{ Params: { id: string } }>('/api/events/:id/read', async (request) => {
    const id = parseInt(request.params.id);
    await db.update(schema.events).set({ read: true }).where(eq(schema.events.id, id)).run();
    return { success: true };
  });

  // Mark all as read
  app.post('/api/events/read-all', async () => {
    await db.update(schema.events).set({ read: true }).where(eq(schema.events.read, false)).run();
    return { success: true };
  });

  // Clear all events
  app.delete('/api/events', async () => {
    await db.delete(schema.events).run();
    return { success: true };
  });
}
