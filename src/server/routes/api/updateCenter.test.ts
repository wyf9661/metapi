import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

const {
  fetchLatestStableGitHubReleaseMock,
  fetchDockerHubTagCandidatesMock,
} = vi.hoisted(() => ({
  fetchLatestStableGitHubReleaseMock: vi.fn(),
  fetchDockerHubTagCandidatesMock: vi.fn(),
}));

vi.mock('../../services/updateCenterVersionService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/updateCenterVersionService.js')>('../../services/updateCenterVersionService.js');
  return {
    ...actual,
    fetchLatestStableGitHubRelease: (...args: unknown[]) => fetchLatestStableGitHubReleaseMock(...args),
    fetchDockerHubTagCandidates: (...args: unknown[]) => fetchDockerHubTagCandidatesMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');
type RuntimeStateModule = typeof import('../../services/updateCenterRuntimeStateService.js');

const GITHUB_RELEASE = {
  source: 'github-release' as const,
  rawVersion: 'v1.6.0',
  normalizedVersion: '1.6.0',
  url: 'https://github.com/wyf9661/metapi/releases/tag/v1.6.0',
  tagName: 'v1.6.0',
  digest: null,
  displayVersion: '1.6.0',
  publishedAt: '2026-08-10T00:00:00Z',
};

const DOCKER_TAG = {
  primary: {
    source: 'docker-hub-tag' as const,
    rawVersion: '1.6.0',
    normalizedVersion: '1.6.0',
    url: null,
    tagName: '1.6.0',
    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    displayVersion: '1.6.0 @ sha256:aaaaaaaaaaaa',
    publishedAt: '2026-08-10T00:00:00Z',
  },
  recentNonStable: [],
};

describe('update center routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let loadUpdateCenterRuntimeState: RuntimeStateModule['loadUpdateCenterRuntimeState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-update-center-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./updateCenter.js');
    const runtimeStateModule = await import('../../services/updateCenterRuntimeStateService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    loadUpdateCenterRuntimeState = runtimeStateModule.loadUpdateCenterRuntimeState;

    app = Fastify();
    await app.register(routesModule.updateCenterRoutes);
  });

  beforeEach(async () => {
    fetchLatestStableGitHubReleaseMock.mockReset();
    fetchDockerHubTagCandidatesMock.mockReset();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    delete process.env.DATA_DIR;
  });

  it('returns partial status when a single version source lookup fails', async () => {
    fetchLatestStableGitHubReleaseMock.mockRejectedValue(new Error('GitHub API timeout'));
    fetchDockerHubTagCandidatesMock.mockResolvedValue(DOCKER_TAG);

    const response = await app.inject({
      method: 'GET',
      url: '/api/update-center/status',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.githubRelease).toBeNull();
    expect(body.dockerHubTag).not.toBeNull();
    expect(body.dockerHubTag.normalizedVersion).toBe('1.6.0');
    expect(body.currentVersion).toBeTypeOf('string');
  });

  it('persists the snapshot after a manual check and reuses it for later status requests', async () => {
    fetchLatestStableGitHubReleaseMock.mockResolvedValue(GITHUB_RELEASE);
    fetchDockerHubTagCandidatesMock.mockResolvedValue(DOCKER_TAG);

    const check = await app.inject({
      method: 'POST',
      url: '/api/update-center/check',
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().githubRelease.normalizedVersion).toBe('1.6.0');

    // Second probe resets: status must come from the persisted snapshot.
    fetchLatestStableGitHubReleaseMock.mockRejectedValue(new Error('should not re-query'));
    fetchDockerHubTagCandidatesMock.mockRejectedValue(new Error('should not re-query'));

    const status = await app.inject({
      method: 'GET',
      url: '/api/update-center/status',
    });
    expect(status.statusCode).toBe(200);
    const body = status.json();
    expect(body.githubRelease.normalizedVersion).toBe('1.6.0');
    expect(body.dockerHubTag.normalizedVersion).toBe('1.6.0');

    const runtime = await loadUpdateCenterRuntimeState();
    expect(runtime.statusSnapshot?.githubRelease?.normalizedVersion).toBe('1.6.0');
  });

  it('re-queries live sources when no snapshot has been persisted yet', async () => {
    fetchLatestStableGitHubReleaseMock.mockResolvedValue(GITHUB_RELEASE);
    fetchDockerHubTagCandidatesMock.mockResolvedValue(DOCKER_TAG);

    const status = await app.inject({
      method: 'GET',
      url: '/api/update-center/status',
    });

    expect(status.statusCode).toBe(200);
    expect(fetchLatestStableGitHubReleaseMock).toHaveBeenCalledTimes(1);
    expect(fetchDockerHubTagCandidatesMock).toHaveBeenCalledTimes(1);
  });

  it('records the current version from runtime', async () => {
    fetchLatestStableGitHubReleaseMock.mockResolvedValue(GITHUB_RELEASE);
    fetchDockerHubTagCandidatesMock.mockResolvedValue(DOCKER_TAG);

    const response = await app.inject({
      method: 'GET',
      url: '/api/update-center/status',
    });
    const body = response.json();
    expect(body.currentVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
