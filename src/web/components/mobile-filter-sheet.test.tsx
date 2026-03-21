import { describe, expect, it, vi } from 'vitest';
import { create } from 'react-test-renderer';
import MobileFilterSheet from './MobileFilterSheet.js';

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

describe('MobileFilterSheet', () => {
  it('wraps content with the shared filter panel shell', () => {
    vi.stubGlobal('document', {
      body: {
        style: {
          overflow: '',
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    try {
      const root = create(
        <MobileFilterSheet open onClose={() => {}} title="筛选条件">
          <div>FilterContent</div>
        </MobileFilterSheet>,
      );

      const text = root.root.findAll(() => true)
        .flatMap((instance) => instance.children)
        .filter((child): child is string => typeof child === 'string')
        .join('');

      expect(text).toContain('筛选条件');
      expect(text).toContain('FilterContent');
      expect(root.root.find((node) => node.props?.className === 'mobile-filter-panel')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
