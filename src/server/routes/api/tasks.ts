import { FastifyInstance } from 'fastify';
import { getBackgroundTask, listBackgroundTasks } from '../../services/backgroundTaskService.js';
import { normalizePageSize } from './paginationNormalizers.js';

export async function taskRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>('/api/tasks', async (request) => {
    const limit = normalizePageSize(request.query.limit, 50, 200);
    return {
      tasks: listBackgroundTasks(limit),
    };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = getBackgroundTask(request.params.id);
    if (!task) {
      return reply.code(404).send({ success: false, message: 'task not found' });
    }
    return {
      success: true,
      task,
    };
  });
}
