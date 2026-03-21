import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import ResponsiveFormGrid from './ResponsiveFormGrid.js';

describe('ResponsiveFormGrid', () => {
  it('applies the shared responsive grid class contract', () => {
    const root = create(
      <ResponsiveFormGrid columns={3}>
        <div>Field A</div>
        <div>Field B</div>
      </ResponsiveFormGrid>,
    );

    const container = root.root.findByType('div');
    expect(container.props.className).toContain('responsive-form-grid');
    expect(container.props.className).toContain('responsive-form-grid-3');
  });
});
