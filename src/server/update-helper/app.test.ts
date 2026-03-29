import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildUpdateHelperApp } from './app.js';

describe('update helper app', () => {
  const apps: Array<Awaited<ReturnType<typeof buildUpdateHelperApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('requires bearer auth for protected helper routes', async () => {
    const app = await buildUpdateHelperApp({
      token: 'helper-token',
      getStatus: vi.fn(),
      deploy: vi.fn(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/status?namespace=ai&releaseName=metapi',
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows unauthenticated health checks', async () => {
    const app = await buildUpdateHelperApp({
      token: 'helper-token',
      getStatus: vi.fn(),
      deploy: vi.fn(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('returns helper status for authorized requests', async () => {
    const getStatus = vi.fn().mockResolvedValue({
      ok: true,
      releaseName: 'metapi',
      namespace: 'ai',
      revision: '17',
      imageRepository: '1467078763/metapi',
      imageTag: '1.3.1',
      healthy: true,
    });

    const app = await buildUpdateHelperApp({
      token: 'helper-token',
      getStatus,
      deploy: vi.fn(),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/status?namespace=ai&releaseName=metapi',
      headers: {
        authorization: 'Bearer helper-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      healthy: true,
      releaseName: 'metapi',
      namespace: 'ai',
    });
    expect(getStatus).toHaveBeenCalledWith({
      namespace: 'ai',
      releaseName: 'metapi',
    });
  });

  it('streams deploy logs and final result as SSE when requested', async () => {
    const deploy = vi.fn().mockImplementation(async (input, onLog) => {
      onLog?.('Running helm upgrade');
      onLog?.('Waiting for rollout');
      return {
        success: true,
        targetSource: input.targetSource,
        targetTag: input.targetTag,
        previousRevision: '17',
        finalRevision: '18',
        rolledBack: false,
        logLines: ['Running helm upgrade', 'Waiting for rollout'],
      };
    });

    const app = await buildUpdateHelperApp({
      token: 'helper-token',
      getStatus: vi.fn(),
      deploy,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/deploy',
      headers: {
        authorization: 'Bearer helper-token',
        accept: 'text/event-stream',
      },
      payload: {
        namespace: 'ai',
        releaseName: 'metapi',
        chartRef: 'oci://ghcr.io/cita-777/charts/metapi',
        imageRepository: '1467078763/metapi',
        source: 'github-release',
        targetVersion: '1.3.0',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: log');
    expect(response.body).toContain('Running helm upgrade');
    expect(response.body).toContain('event: result');
    expect(response.body).toContain('"targetTag":"1.3.0"');
  });
});
