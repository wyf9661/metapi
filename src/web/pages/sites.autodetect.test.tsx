import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getOAuthProviders: vi.fn().mockResolvedValue({ providers: [] }),
    detectSite: vi.fn(),
    getSiteAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

vi.mock('../components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => toastMock,
}));

const DEBOUNCE_MS = 700;

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Let the auto-detect debounce elapse and the probe settle. */
async function settleDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 50);
  });
  await flushMicrotasks();
}

async function openAddSiteEditor(root: ReactTestRenderer) {
  const openAddButton = root.root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && typeof node.props.className === 'string'
    && node.props.className.includes('btn btn-primary')
    && JSON.stringify(node.props.children).includes('添加站点')
  ));
  await act(async () => {
    openAddButton.props.onClick();
  });
  await flushMicrotasks();
}

function findPrimarySiteUrlInput(root: ReactTestRenderer) {
  return root.root.find((node) => (
    node.type === 'input'
    && node.props['data-testid'] === 'site-primary-url-input'
  ));
}

function findProxyUrlInput(root: ReactTestRenderer) {
  return root.root.find((node) => (
    node.type === 'input'
    && node.props['data-testid'] === 'site-proxy-url-input'
  ));
}

async function typeInto(root: ReactTestRenderer, finder: (r: ReactTestRenderer) => any, value: string) {
  await act(async () => {
    finder(root).props.onChange({ target: { value } });
  });
  await flushMicrotasks();
}

describe('Sites auto detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    apiMock.getSites.mockResolvedValue([]);
    apiMock.detectSite.mockResolvedValue({
      platform: 'new-api',
      url: 'https://auto.example.com',
      initializationPresetId: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('detects as soon as the typed url settles, without blur or button click', async () => {
    let root!: ReactTestRenderer;
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
      await openAddSiteEditor(root);

      await typeInto(root, findPrimarySiteUrlInput, 'https://auto.example.com');
      expect(apiMock.detectSite).not.toHaveBeenCalled();

      await settleDebounce();
      expect(apiMock.detectSite).toHaveBeenCalledWith('https://auto.example.com');
    } finally {
      root?.unmount();
    }
  });

  it('re-runs detection with the proxy once the operator fills the proxy field', async () => {
    let root!: ReactTestRenderer;
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
      await openAddSiteEditor(root);

      await typeInto(root, findPrimarySiteUrlInput, 'https://auto.example.com');
      await settleDebounce();
      expect(apiMock.detectSite).toHaveBeenCalledTimes(1);

      await typeInto(root, findProxyUrlInput, 'http://127.0.0.1:7890');
      await settleDebounce();

      expect(apiMock.detectSite).toHaveBeenCalledTimes(2);
      expect(apiMock.detectSite).toHaveBeenLastCalledWith(
        'https://auto.example.com',
        'http://127.0.0.1:7890',
      );
    } finally {
      root?.unmount();
    }
  });

  it('does not probe while the url is still partial', async () => {
    let root!: ReactTestRenderer;
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
      await openAddSiteEditor(root);

      await typeInto(root, findPrimarySiteUrlInput, 'htt');
      await settleDebounce();
      await typeInto(root, findPrimarySiteUrlInput, 'https://auto.');
      await settleDebounce();

      expect(apiMock.detectSite).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('stays quiet when an automatic probe finds nothing', async () => {
    let root!: ReactTestRenderer;
    try {
      apiMock.detectSite.mockResolvedValue({ error: 'Could not detect platform' });
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
      await openAddSiteEditor(root);

      await typeInto(root, findPrimarySiteUrlInput, 'https://auto.example.com');
      await settleDebounce();

      expect(apiMock.detectSite).toHaveBeenCalledTimes(1);
      expect(toastMock.error).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
