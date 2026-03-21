import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import MobileBatchBar from './MobileBatchBar.js';

describe('MobileBatchBar', () => {
  it('renders info text and action content inside the shared batch bar shell', () => {
    const root = create(
      <MobileBatchBar info="已选 2 项">
        <button type="button">批量删除</button>
      </MobileBatchBar>,
    );

    const text = root.root.findAll(() => true)
      .flatMap((instance) => instance.children)
      .filter((child): child is string => typeof child === 'string')
      .join('');

    expect(text).toContain('已选 2 项');
    expect(text).toContain('批量删除');
    expect(root.root.find((node) => node.props?.className === 'mobile-actions-bar mobile-batch-bar')).toBeTruthy();
  });
});
