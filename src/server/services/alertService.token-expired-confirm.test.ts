import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();
const sendNotificationMock = vi.fn();
const setAccountRuntimeHealthMock = vi.fn();

vi.mock('../db/index.js', () => {
  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };
  const updateWhereChain = {
    run: () => ({}),
  };
  const updateSetChain = {
    where: () => updateWhereChain,
  };
  return {
    db: {
      insert: () => insertChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
    },
    schema: {
      events: {},
      accounts: { id: 'id', siteId: 'siteId', status: 'status' },
    },
  };
});

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setAccountRuntimeHealthMock(...args),
}));

import {
  __resetTokenExpiredSightingStateForTests,
  noteTokenExpiredSighting,
  reportTokenExpired,
  resetTokenExpiredSightings,
  TOKEN_EXPIRED_CONFIRM_REQUIRED,
  TOKEN_EXPIRED_CONFIRM_WINDOW_MS,
} from './alertService.js';

describe('token expired confirmation', () => {
  beforeEach(() => {
    __resetTokenExpiredSightingStateForTests();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
    sendNotificationMock.mockReset();
    setAccountRuntimeHealthMock.mockReset();
  });

  it('requires two sightings within the window to confirm', () => {
    expect(TOKEN_EXPIRED_CONFIRM_REQUIRED).toBe(2);
    const t0 = 1_000;
    expect(noteTokenExpiredSighting(1, t0)).toBe(false);
    expect(noteTokenExpiredSighting(1, t0 + 10_000)).toBe(true);
  });

  it('resets the counter when the window expires', () => {
    const t0 = 1_000;
    expect(noteTokenExpiredSighting(2, t0)).toBe(false);
    // Beyond the window → fresh count, still not confirmed.
    expect(noteTokenExpiredSighting(2, t0 + TOKEN_EXPIRED_CONFIRM_WINDOW_MS + 1)).toBe(false);
    expect(noteTokenExpiredSighting(2, t0 + TOKEN_EXPIRED_CONFIRM_WINDOW_MS + 2_000)).toBe(true);
  });

  it('resetTokenExpiredSightings clears pending sightings', () => {
    const t0 = 1_000;
    noteTokenExpiredSighting(3, t0);
    resetTokenExpiredSightings(3);
    expect(noteTokenExpiredSighting(3, t0 + 1_000)).toBe(false);
  });

  it('first sighting only downgrades health; second sighting triggers full alert', async () => {
    await reportTokenExpired({ accountId: 7, siteId: 9, username: 'u', siteName: 's', detail: 'invalid token' });

    // First hit: no event, no expired status, no external push.
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(7, expect.objectContaining({
      state: 'degraded',
      source: 'auth',
    }));

    await reportTokenExpired({ accountId: 7, siteId: 9, username: 'u', siteName: 's', detail: 'invalid token' });

    // Second hit within the window: full side effects.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('tracks sightings per account independently', async () => {
    await reportTokenExpired({ accountId: 10, siteId: 1, username: 'a' });
    await reportTokenExpired({ accountId: 11, siteId: 1, username: 'b' });
    expect(sendNotificationMock).not.toHaveBeenCalled();

    await reportTokenExpired({ accountId: 10, siteId: 1, username: 'a' });
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('auto-recovers without pushing when the confirm re-verify succeeds', async () => {
    await reportTokenExpired({ accountId: 20, siteId: 1, username: 'c' });
    // Second sighting: confirmed, but the live check proves the token works.
    await reportTokenExpired({ accountId: 20, siteId: 1, username: 'c' }, () => ({ balance: 5, used: 0, quota: 5 }));

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    // Auto-recovery: status back to active, health healthy, sightings cleared.
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(20, expect.objectContaining({
      state: 'healthy',
      source: 'balance',
    }));
    // A later spurious sighting starts counting from zero again.
    await reportTokenExpired({ accountId: 20, siteId: 1, username: 'c' });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('proceeds with the full alert when the confirm re-verify fails', async () => {
    await reportTokenExpired({ accountId: 21, siteId: 1, username: 'd' });
    await reportTokenExpired({ accountId: 21, siteId: 1, username: 'd' }, () => {
      throw new Error('still expired');
    });

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
