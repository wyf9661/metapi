import { describe, expect, it } from 'vitest';

import {
  executeUpdateHelperDeploy,
  getUpdateHelperStatus,
} from './service.js';

describe('update helper service', () => {
  it('builds helm upgrade and rollout verification commands with the configured release metadata', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const summary = await executeUpdateHelperDeploy(
      {
        namespace: 'ai',
        releaseName: 'metapi',
        chartRef: 'oci://ghcr.io/cita-777/charts/metapi',
        imageRepository: '1467078763/metapi',
        targetSource: 'github-release',
        targetTag: '1.3.0',
      },
      {
        runCommand: async ({ command, args }) => {
          calls.push({ command, args });
          if (command === 'helm' && args[0] === 'history') {
            return {
              stdout: JSON.stringify([{ revision: '12' }]),
            };
          }
          if (command === 'helm' && args[0] === 'status') {
            return {
              stdout: JSON.stringify({
                version: 13,
              }),
            };
          }
          return { stdout: '' };
        },
      },
    );

    expect(calls).toEqual([
      {
        command: 'helm',
        args: ['history', 'metapi', '-n', 'ai', '-o', 'json'],
      },
      {
        command: 'helm',
        args: [
          'upgrade',
          'metapi',
          'oci://ghcr.io/cita-777/charts/metapi',
          '--namespace',
          'ai',
          '--reuse-values',
          '--set',
          'image.repository=1467078763/metapi',
          '--set',
          'image.tag=1.3.0',
        ],
      },
      {
        command: 'kubectl',
        args: [
          'rollout',
          'status',
          'deployment',
          '-n',
          'ai',
          '-l',
          'app.kubernetes.io/instance=metapi',
          '--timeout=300s',
        ],
      },
      {
        command: 'helm',
        args: ['status', 'metapi', '-n', 'ai', '-o', 'json'],
      },
    ]);
    expect(summary).toMatchObject({
      success: true,
      targetSource: 'github-release',
      targetTag: '1.3.0',
      previousRevision: '12',
      finalRevision: '13',
      rolledBack: false,
    });
  });

  it('rolls back to the previous revision when rollout verification fails', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(() => executeUpdateHelperDeploy(
      {
        namespace: 'ai',
        releaseName: 'metapi',
        chartRef: 'oci://ghcr.io/cita-777/charts/metapi',
        imageRepository: '1467078763/metapi',
        targetSource: 'docker-hub-tag',
        targetTag: '1.3.1',
      },
      {
        runCommand: async ({ command, args }) => {
          calls.push({ command, args });
          if (command === 'helm' && args[0] === 'history') {
            return {
              stdout: JSON.stringify([{ revision: '22' }]),
            };
          }
          if (command === 'kubectl' && args[0] === 'rollout') {
            throw new Error('rollout status timed out');
          }
          return { stdout: '' };
        },
      },
    )).rejects.toThrow('rollout status timed out');

    expect(calls).toEqual(expect.arrayContaining([
      {
        command: 'helm',
        args: ['rollback', 'metapi', '22', '-n', 'ai'],
      },
    ]));
  });

  it('parses helper status from helm status and values output', async () => {
    const status = await getUpdateHelperStatus(
      {
        namespace: 'ai',
        releaseName: 'metapi',
      },
      {
        runCommand: async ({ command, args }) => {
          if (command === 'helm' && args[0] === 'status') {
            return {
              stdout: JSON.stringify({
                version: 17,
                info: {
                  status: 'deployed',
                },
              }),
            };
          }
          if (command === 'helm' && args[0] === 'get') {
            return {
              stdout: JSON.stringify({
                image: {
                  repository: '1467078763/metapi',
                  tag: '1.3.1',
                },
              }),
            };
          }
          throw new Error('unexpected command');
        },
      },
    );

    expect(status).toEqual({
      ok: true,
      releaseName: 'metapi',
      namespace: 'ai',
      revision: '17',
      imageRepository: '1467078763/metapi',
      imageTag: '1.3.1',
      healthy: true,
    });
  });
});
