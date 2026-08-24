import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { usePersistedPageSize } from './usePersistedPageSize.js';
import { useIsMobile } from './useIsMobile.js';

vi.mock('./useIsMobile.js', () => ({
  useIsMobile: vi.fn(),
}));

// The vitest environment has no localStorage; shim an in-memory store.
const storage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (key: string) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  },
  configurable: true,
});

// Minimal wrapper to test the hook
function TestHarness({ scope }: { scope: string }) {
  const [pageSize, setPageSize] = usePersistedPageSize(scope);
  return (
    <div>
      <span data-testid="pageSize">{pageSize}</span>
      <button onClick={() => setPageSize(20)}>set20</button>
      <button onClick={() => setPageSize(5)}>set5</button>
    </div>
  );
}

describe('usePersistedPageSize', () => {
  afterEach(() => {
    vi.clearAllMocks();
    storage.clear();
  });

  it('defaults to DESKTOP_DEFAULT_PAGE_SIZE (10) on desktop', () => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    const root = create(<TestHarness scope="test" />);
    const text = root.root.findByProps({ 'data-testid': 'pageSize' }).children[0];
    expect(Number(text)).toBe(10);
    root.unmount();
  });

  it('defaults to MOBILE_DEFAULT_PAGE_SIZE (5) on mobile', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    const root = create(<TestHarness scope="test" />);
    const text = root.root.findByProps({ 'data-testid': 'pageSize' }).children[0];
    expect(Number(text)).toBe(5);
    root.unmount();
  });

  it('persists a changed value to localStorage and reads it back', () => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    const root = create(<TestHarness scope="persist" />);
    const set20 = root.root.findAll((n) => n.type === 'button' && n.children[0] === 'set20')[0];

    act(() => set20.props.onClick());

    const stored = window.localStorage.getItem('metapi.pageSize.persist.desktop');
    expect(stored).toBe('20');

    // Unmount and re-mount — should read from storage
    root.unmount();
    const root2 = create(<TestHarness scope="persist" />);
    const text = root2.root.findByProps({ 'data-testid': 'pageSize' }).children[0];
    expect(Number(text)).toBe(20);
    root2.unmount();
  });
});