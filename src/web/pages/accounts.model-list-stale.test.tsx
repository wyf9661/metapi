import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderAccounts(runtimeHealth: Record<string, unknown>) {
  apiMock.getAccounts.mockResolvedValue([
    {
      id: 1,
      username: 'stale-user',
      accessToken: 'api-key-only-token',
      status: 'active',
      credentialMode: 'apikey',
      modelCount: 3,
      capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
      runtimeHealth,
      siteId: 10,
      site: { id: 10, name: '小呆api', platform: 'new-api', status: 'active', url: 'https://example.com' },
    },
  ]);
  apiMock.getSites.mockResolvedValue([{ id: 10, name: '小呆api', platform: 'new-api', status: 'active' }]);

  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
        <ToastProvider>
          <Accounts />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root;
}

describe('Accounts model list staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks the model list as a previous result when model discovery fails', async () => {
    const root = await renderAccounts({
      state: 'unhealthy',
      source: 'model-discovery',
      reason: '模型获取失败：未获取到可用模型',
      checkedAt: '2026-11-03T02:05:00.000Z',
    });
    try {
      const notes = root.root.findAll((node) => collectText(node).includes('刷新失败，显示上次结果'));
      expect(notes.length).toBeGreaterThan(0);
      // The failure reason rides along as the tooltip, as on the health badge.
      expect(JSON.stringify(root.toJSON())).toContain('模型获取失败：未获取到可用模型');
    } finally {
      root.unmount();
    }
  });

  it('does not mark the list when the account is healthy', async () => {
    const root = await renderAccounts({
      state: 'healthy',
      source: 'model-discovery',
      reason: '模型探测成功',
      checkedAt: '2026-11-03T02:05:00.000Z',
    });
    try {
      expect(JSON.stringify(root.toJSON())).not.toContain('刷新失败，显示上次结果');
    } finally {
      root.unmount();
    }
  });
});
