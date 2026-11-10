import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();
const sendNotificationMock = vi.fn();
const setAccountRuntimeHealthMock = vi.fn();
const recentSuccessGetMock = vi.fn();

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
  // Proxy-log lookup: db.select(...).from(...).where(...).limit(1).get()
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => selectChain,
    get: () => recentSuccessGetMock(),
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
      select: () => selectChain,
    },
    schema: {
      events: {},
      accounts: { id: 'id', siteId: 'siteId', status: 'status' },
      proxyLogs: {
        id: 'id',
        accountId: 'account_id',
        status: 'status',
        createdAt: 'created_at',
      },
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
    recentSuccessGetMock.mockReset();
    // Default: no successful request from this account in the window, i.e. the
    // 401 is the only evidence — the alert must still fire.
    recentSuccessGetMock.mockReturnValue(undefined);
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

  it('does not let proxy successes hide an expired check-in session', async () => {
    recentSuccessGetMock.mockReturnValue({ id: 1 });

    await reportTokenExpired({ accountId: 30, siteId: 1, detail: 'access token 无效' });
    await reportTokenExpired({ accountId: 30, siteId: 1, detail: 'access token 无效' });

    expect(recentSuccessGetMock).not.toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a suppressed proxy failure clear check-in expiry sightings', async () => {
    recentSuccessGetMock.mockReturnValue({ id: 1 });

    await reportTokenExpired({ accountId: 30, siteId: 1, detail: 'access token 无效' });
    await reportTokenExpired({ accountId: 30, siteId: 1, detail: 'HTTP 401', proxyTokenId: 229 });
    await reportTokenExpired({ accountId: 30, siteId: 1, detail: 'access token 无效' });

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('keeps the existing confirmation flow when the success lookup fails', async () => {
    recentSuccessGetMock.mockRejectedValue(new Error('success evidence unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const params = { accountId: 31, siteId: 1, proxyTokenId: 229, detail: 'HTTP 401' };
      await expect(reportTokenExpired(params)).resolves.toBeUndefined();
      await expect(reportTokenExpired(params)).resolves.toBeUndefined();
      expect(sendNotificationMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not let proxy traffic override a failed live credential verification', async () => {
    recentSuccessGetMock.mockReturnValue({ id: 1 });
    const params = { accountId: 32, siteId: 1, proxyTokenId: 229, detail: 'invalid access token' };
    const verify = vi.fn(() => { throw new Error('still expired'); });

    await reportTokenExpired(params, verify);
    await reportTokenExpired(params, verify);

    expect(recentSuccessGetMock).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('does not report an expiry when the account served a request in the window', async () => {
    // A relay whose own upstream channel key expired answers 401 "Invalid token"
    // on those picks while its sibling channels keep serving our account. The
    // 401 is channel-scoped noise, not credential death.
    recentSuccessGetMock.mockReturnValue({ id: 1 });

    await reportTokenExpired({ accountId: 30, siteId: 1, username: 'relay-user', detail: 'HTTP 401', proxyTokenId: 229 });
    await reportTokenExpired({ accountId: 30, siteId: 1, username: 'relay-user', detail: 'HTTP 401', proxyTokenId: 229 });

    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
    // Silent: not even the degraded badge — the key is provably working.
    expect(setAccountRuntimeHealthMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });
});
