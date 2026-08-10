import { FastifyInstance } from 'fastify';

import {
  getUpdateCenterStatus,
  refreshUpdateCenterStatusCache,
} from '../../services/updateCenterStatusService.js';

export async function updateCenterRoutes(app: FastifyInstance) {
  app.get('/api/update-center/status', async () => {
    return await getUpdateCenterStatus();
  });

  app.post('/api/update-center/check', async () => {
    return (await refreshUpdateCenterStatusCache()).status;
  });
}
