import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import Sites from './Sites.js';

// The mobile pagination path (mobile-card-list) only renders under the mobile
// breakpoint; jsdom's default viewport is desktop-wide.
vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getOAuthProviders: vi.fn().mockResolvedValue({ providers: [] }),
    getSiteAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
  },
}));
vi.mock('../api.js', () => ({ api: apiMock }));

const records = Array.from({ length: 13 }, (_, i) => ({
  id: i + 1, name: `SITE-${String(i + 1).padStart(2, '0')}`,
  url: `https://site${i + 1}.example.com`, platform: 'new-api', status: 'active',
}));
let latestSearch = '';
function LocationObserver() {
  latestSearch = useLocation().search;
  return null;
}
type TestRenderer = ReturnType<typeof create>;
function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function pageRows(root: TestRenderer): string[] {
  const mobileList = root.root.find((node: ReactTestInstance) => node.type === 'div' && node.props.className === 'mobile-card-list');
  const rows = mobileList.findAll((node: ReactTestInstance) => (
    node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('site-card-draggable')
  ));
  return rows.map(text);
}
function paginationButton(root: TestRenderer, label: string) {
  return root.root.find((node: ReactTestInstance) => node.type === 'button'
    && typeof node.props.className === 'string' && node.props.className.includes('pagination-btn')
    && text(node).trim() === label);
}
async function render(initialEntry: string) {
  let root!: TestRenderer;
  await act(async () => {
    root = create(<MemoryRouter initialEntries={[initialEntry]}><LocationObserver /><ToastProvider><Sites /></ToastProvider></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return root;
}

describe('Sites pagination state and URL', () => {
  beforeEach(() => {
    latestSearch = '';
    apiMock.getSites.mockResolvedValue(records);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('shows exactly the new mobile page when clicking a page number', async () => {
    const root = await render('/sites?page=1');
    try {
      expect(pageRows(root).some((x) => x.includes('SITE-01'))).toBe(true);
      await act(async () => { paginationButton(root, '2').props.onClick(); });
      expect(latestSearch).toBe('?page=2');
      const rows = pageRows(root);
      expect(rows.length).toBe(5);
      expect(rows.some((x) => x.includes('SITE-01'))).toBe(false);
      expect(rows.some((x) => x.includes('SITE-06'))).toBe(true);
    } finally { await act(async () => { root.unmount(); }); }
  });

  it('does not bounce between an old page and page one when the page size changes', async () => {
    const root = await render('/sites?page=2');
    try {
      expect(pageRows(root).some((x) => x.includes('SITE-06'))).toBe(true);
      // Changing the page size resets the pagination hook to page 1; the URL
      // must follow instead of staying at the stale ?page=2 that the page-sync
      // effect would otherwise use to drag the state back.
      const sizeSelect = root.root.find((node) => node.type === ModernSelect);
      await act(async () => { sizeSelect.props.onChange('10'); });
      expect(latestSearch).toBe('');
      expect(pageRows(root).some((x) => x.includes('SITE-01'))).toBe(true);
    } finally { await act(async () => { root.unmount(); }); }
  });
});
