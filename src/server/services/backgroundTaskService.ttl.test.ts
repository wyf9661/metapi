import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetBackgroundTasksForTests,
  getBackgroundTask,
  startBackgroundTask,
} from './backgroundTaskService.js';

const TASK_TTL_MS = 6 * 60 * 60 * 1000;

describe('background task TTL cleanup', () => {
  afterEach(() => {
    __resetBackgroundTasksForTests();
    vi.useRealTimers();
  });

  it('keeps a running task past its TTL and retires it only after completion', async () => {
    vi.useFakeTimers();
    const gate = { release: null as (() => void) | null };
    const runnerGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    const { task } = startBackgroundTask(
      { type: 'ttl.probe', title: 'TTL probe' },
      async () => {
        await runnerGate;
        return { ok: true };
      },
    );
    expect(getBackgroundTask(task.id)?.status).toBe('running');

    // Crossing the TTL while still running must NOT evict the task: the
    // runner is still executing and waitForBackgroundTaskCompletion / the
    // live log stream would silently lose it.
    await vi.advanceTimersByTimeAsync(TASK_TTL_MS + 2 * 60_000);
    const stillRunning = getBackgroundTask(task.id);
    expect(stillRunning).not.toBeNull();
    expect(stillRunning?.status).toBe('running');

    // Completion retires normally; the terminal task then expires on schedule.
    gate.release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(getBackgroundTask(task.id)?.status).toBe('succeeded');
    await vi.advanceTimersByTimeAsync(TASK_TTL_MS + 2 * 60_000);
    expect(getBackgroundTask(task.id)).toBeNull();
  });
});
