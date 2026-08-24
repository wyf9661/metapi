import { describe, expect, it, vi } from 'vitest';
import { create, type ReactTestInstance } from 'react-test-renderer';
import PaginationControls from './PaginationControls.js';

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

describe('PaginationControls', () => {
  const onPageChange = vi.fn();
  const onPageSizeChange = vi.fn();

  it('renders page navigation and page info when totalPages > 1', () => {
    const root = create(
      <PaginationControls
        page={2}
        totalPages={10}
        onPageChange={onPageChange}
        visible
      />,
    );
    const text = collectText(root.root);
    expect(text).toContain('上一页');
    expect(text).toContain('下一页');
    expect(text).toContain('第 2 / 10 页');
    root.unmount();
  });

  it('renders nothing when visible is false', () => {
    const root = create(
      <PaginationControls
        page={1}
        totalPages={5}
        onPageChange={onPageChange}
        visible={false}
      />,
    );
    expect(root.root.children.length).toBe(0);
    root.unmount();
  });

  it('renders range label when provided', () => {
    const root = create(
      <PaginationControls
        page={1}
        totalPages={3}
        onPageChange={onPageChange}
        visible
        rangeLabel="显示第 1 - 10 条，共 25 条"
      />,
    );
    const text = collectText(root.root);
    expect(text).toContain('显示第 1 - 10 条，共 25 条');
    root.unmount();
  });

  it('renders page-size selector when pageSize and onPageSizeChange are provided', () => {
    const root = create(
      <PaginationControls
        page={1}
        totalPages={3}
        onPageChange={onPageChange}
        visible
        pageSize={10}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    const text = collectText(root.root);
    expect(text).toContain('每页条数');
    root.unmount();
  });

  it('hides page navigation buttons when totalPages <= 1 but still shows range and size selector', () => {
    const root = create(
      <PaginationControls
        page={1}
        totalPages={1}
        onPageChange={onPageChange}
        visible
        rangeLabel="显示第 1 - 10 条，共 10 条"
        pageSize={10}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    const text = collectText(root.root);
    expect(text).toContain('显示第 1 - 10 条，共 10 条');
    expect(text).toContain('每页条数');
    expect(text).not.toContain('上一页');
    expect(text).not.toContain('下一页');
    root.unmount();
  });
});