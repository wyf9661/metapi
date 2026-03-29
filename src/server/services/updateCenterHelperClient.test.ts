import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

import { getUpdateCenterHelperStatus } from './updateCenterHelperClient.js';

describe('update center helper client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('maps helper status aborts to a timeout error', async () => {
    const abortError = new Error('aborted');
    (abortError as Error & { name: string }).name = 'AbortError';
    fetchMock.mockRejectedValue(abortError);

    await expect(getUpdateCenterHelperStatus({
      enabled: true,
      helperBaseUrl: 'http://metapi-deploy-helper.ai.svc.cluster.local:9850',
      namespace: 'ai',
      releaseName: 'metapi',
      chartRef: 'oci://ghcr.io/cita-777/charts/metapi',
      imageRepository: '1467078763/metapi',
      githubReleasesEnabled: true,
      dockerHubTagsEnabled: true,
      defaultDeploySource: 'github-release',
    }, 'helper-token')).rejects.toThrow('deploy helper status timeout');
  });
});
