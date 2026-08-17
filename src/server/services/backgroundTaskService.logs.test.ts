import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetBackgroundTasksForTests,
  appendBackgroundTaskLog,
  getBackgroundTask,
  startBackgroundTask,
  subscribeToBackgroundTaskLogs,
} from './backgroundTaskService.js';

describe('background task log streaming', () => {
  afterEach(() => {
    __resetBackgroundTasksForTests();
  });

  it('appends log entries in order and exposes them through task lookups', async () => {
    const gate = { release: null as (() => void) | null };
    const runnerGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => {
        await runnerGate;
        return { success: true };
      },
    );

    appendBackgroundTaskLog(task.id, 'Resolving target version');
    appendBackgroundTaskLog(task.id, 'Running helm upgrade');

    const currentTask = getBackgroundTask(task.id);
    expect(currentTask?.logs).toEqual([
      expect.objectContaining({ seq: 1, message: 'Resolving target version' }),
      expect.objectContaining({ seq: 2, message: 'Running helm upgrade' }),
    ]);

    gate.release?.();
  });

  it('notifies subscribers when new log entries arrive', async () => {
    const gate = { release: null as (() => void) | null };
    const runnerGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => {
        await runnerGate;
        return { success: true };
      },
    );

    const received: string[] = [];
    const unsubscribe = subscribeToBackgroundTaskLogs(task.id, (entry) => {
      received.push(entry.message);
    });

    appendBackgroundTaskLog(task.id, 'Waiting for rollout');
    appendBackgroundTaskLog(task.id, 'Deployment complete');

    expect(received).toEqual([
      'Waiting for rollout',
      'Deployment complete',
    ]);

    unsubscribe();
    gate.release?.();
  });

  it('trims old log entries to a bounded buffer', async () => {
    const gate = { release: null as (() => void) | null };
    const runnerGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    const { task } = startBackgroundTask(
      {
        type: 'update-center.deploy',
        title: '更新部署',
      },
      async () => {
        await runnerGate;
        return { success: true };
      },
    );

    for (let index = 1; index <= 250; index += 1) {
      appendBackgroundTaskLog(task.id, `line-${index}`);
    }

    const currentTask = getBackgroundTask(task.id);
    expect(currentTask?.logs).toHaveLength(200);
    expect(currentTask?.logs[0]).toMatchObject({
      seq: 51,
      message: 'line-51',
    });
    expect(currentTask?.logs.at(-1)).toMatchObject({
      seq: 250,
      message: 'line-250',
    });

    gate.release?.();
  });
});
