import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Dashboard from './Dashboard.js';
import { installDashboardSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getDashboard: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    getDashboardInsights: vi.fn(),
    getSiteSnapshot: vi.fn(),
    getSiteDistribution: vi.fn(),
    getSiteTrend: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function isStatCard(node: ReactTestInstance): boolean {
  return typeof node.props.className === 'string'
    && /(^|\s)stat-card(\s|$)/.test(node.props.className);
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Dashboard performance stat card', () => {
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.clearAllMocks();
    installDashboardSnapshotCompat(apiMock);
    apiMock.getSiteDistribution.mockResolvedValue({ distribution: [] });
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    apiMock.getSites.mockResolvedValue([]);
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    vi.clearAllMocks();
  });

  it('renders RPM and TPM inside a fifth stat card within the same dashboard grid', async () => {
    apiMock.getDashboard.mockResolvedValue({
      totalBalance: 0,
      totalUsed: 0,
      todaySpend: 0,
      todayReward: 0,
      activeAccounts: 0,
      totalAccounts: 0,
      todayCheckin: { success: 0, total: 0 },
      proxy24h: { success: 0, total: 0, totalTokens: 606_573_377 },
      performance: {
        qualityWindowHours: 24,
        qualitySampleCount: 120,
        successRatePercent: 97.5,
        p95FirstByteLatencyMs: 850,
        p95LatencyMs: 2_400,
        qualitySparse: false,
        windowSeconds: 60,
        requestsPerMinute: 17,
        tokensPerMinute: 7_974,
      },
      modelAnalysis: null,
    });

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const statGrid = root!.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('dashboard-stat-grid')
      ));

      const statCards = statGrid.findAll(isStatCard);

      expect(statCards).toHaveLength(3);
      expect(collectText(statGrid)).toContain('性能指标');
      expect(collectText(statGrid)).toContain('RPM');
      expect(collectText(statGrid)).toContain('17');
      expect(collectText(statGrid)).toContain('TPM');
      expect(collectText(statGrid)).toContain('8K');
      expect(collectText(statGrid)).toContain('24h Tokens');
      expect(collectText(statGrid)).toContain('24h 成功率');
      expect(collectText(statGrid)).toContain('97.5%');
      expect(collectText(statGrid)).toContain('P95 首包 / 总耗时');
      expect(collectText(statGrid)).toContain('850ms / 2.4s');
      expect(collectText(statGrid)).toContain('606.6M');
    } finally {
      root?.unmount();
    }
  });

  it('shows three skeleton stat cards while dashboard data is still loading', async () => {
    let resolveDashboard: ((value: Record<string, unknown>) => void) | undefined;
    apiMock.getDashboard.mockImplementation(() => (
      new Promise((resolve) => {
        resolveDashboard = resolve as (value: Record<string, unknown>) => void;
      })
    ));

    let root!: WebTestRenderer;

    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Dashboard />
            </ToastProvider>
          </MemoryRouter>,
        );
      });

      const statGrid = root!.root.find((node) => (
        typeof node.props.className === 'string'
        && node.props.className.includes('dashboard-stat-grid')
      ));
      const statCards = statGrid.findAll(isStatCard);

      expect(statCards).toHaveLength(3);
    } finally {
      if (resolveDashboard) {
        resolveDashboard({
          totalBalance: 0,
          totalUsed: 0,
          todaySpend: 0,
          todayReward: 0,
          activeAccounts: 0,
          totalAccounts: 0,
          todayCheckin: { success: 0, total: 0 },
          proxy24h: { success: 0, total: 0, totalTokens: 0 },
          performance: { windowSeconds: 60, requestsPerMinute: 0, tokensPerMinute: 0 },
          modelAnalysis: null,
        });
      }
      root?.unmount();
    }
  });
});
