import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    batchUpdateSites: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Sites mobile actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Site A',
        url: 'https://a.example.com',
        platform: 'new-api',
        status: 'active',
        useSystemProxy: false,
      },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not render multi-select controls and keeps primary site url on mobile cards', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(() => root.root.find((node) => node.props['data-testid'] === 'sites-mobile-select-all')).toThrow();
      expect(() => root.root.find((node) => node.props['data-testid'] === 'site-select-1')).toThrow();
      expect(() => root.root.find((node) => node.props['data-testid'] === 'sites-batch-enable-system-proxy')).toThrow();

      const primaryLink = root.root.find((node) => node.type === 'a' && node.props.href === 'https://a.example.com');
      expect(primaryLink.props.target).toBe('_blank');
    } finally {
      root?.unmount();
    }
  });
});
