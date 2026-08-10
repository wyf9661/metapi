import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../../components/Toast.js';

import UpdateCenterSection from './UpdateCenterSection.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getUpdateCenterStatus: vi.fn(),
    checkUpdateCenter: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
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

function renderSection() {
  let renderer: ReturnType<typeof create> | null = null;
  act(() => {
    renderer = create(
      <ToastProvider>
        <UpdateCenterSection />
      </ToastProvider>,
    );
  });
  return renderer!;
}

describe('UpdateCenterSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getUpdateCenterStatus.mockResolvedValue({
      currentVersion: '1.2.3',
      githubRelease: {
        normalizedVersion: '1.6.0',
        displayVersion: '1.6.0',
        tagName: 'v1.6.0',
        digest: null,
        publishedAt: null,
      },
      dockerHubTag: {
        normalizedVersion: '1.6.0',
        displayVersion: '1.6.0 @ sha256:aaaaaaaaaaaa',
        tagName: '1.6.0',
        digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        publishedAt: null,
      },
      dockerHubRecentTags: [],
      runtime: {
        lastCheckedAt: '2026-08-10T02:00:00Z',
        lastCheckError: null,
      },
    });
    apiMock.checkUpdateCenter.mockResolvedValue({});
  });

  it('renders current version and both version channels', async () => {
    const renderer = renderSection();
    await flushMicrotasks();

    const text = collectText(renderer.root);
    expect(text).toContain('1.2.3');
    expect(text).toContain('1.6.0');
    expect(text).toContain('GitHub Releases');
    expect(text).toContain('Docker Hub');
  });

  it('shows a new-version reminder badge when a newer release exists', async () => {
    const renderer = renderSection();
    await flushMicrotasks();

    const text = collectText(renderer.root);
    expect(text).toContain('发现新版本');
  });

  it('triggers a manual check via the check button', async () => {
    const renderer = renderSection();
    await flushMicrotasks();

    const buttons = renderer.root.findAllByType('button');
    const checkButton = buttons.find((btn) => collectText(btn).includes('检查更新'));
    expect(checkButton).toBeTruthy();

    await act(async () => {
      checkButton!.props.onClick();
    });

    expect(apiMock.checkUpdateCenter).toHaveBeenCalledTimes(1);
  });

  it('renders the last check error when present', async () => {
    apiMock.getUpdateCenterStatus.mockResolvedValue({
      currentVersion: '1.2.3',
      githubRelease: null,
      dockerHubTag: null,
      dockerHubRecentTags: [],
      runtime: {
        lastCheckedAt: null,
        lastCheckError: 'GitHub API timeout',
      },
    });

    const renderer = renderSection();
    await flushMicrotasks();

    expect(collectText(renderer.root)).toContain('GitHub API timeout');
  });
});
