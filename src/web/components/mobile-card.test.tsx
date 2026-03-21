import { describe, expect, it } from 'vitest';
import { create } from 'react-test-renderer';
import { MobileCard, MobileField } from './MobileCard.js';

describe('MobileCard', () => {
  it('renders separate header and footer action slots plus stacked fields', () => {
    const root = create(
      <MobileCard
        title="CardTitle"
        subtitle="CardSubtitle"
        compact
        headerActions={<span>Meta</span>}
        footerActions={<button type="button">Action</button>}
      >
        <MobileField label="Status" value="OK" />
        <MobileField label="URL" value="https://example.com/very/long/path" stacked />
      </MobileCard>,
    );

    const text = root.root.findAll(() => true)
      .flatMap((instance) => instance.children)
      .filter((child): child is string => typeof child === 'string')
      .join('');

    expect(text).toContain('CardTitle');
    expect(text).toContain('CardSubtitle');
    expect(text).toContain('Meta');
    expect(text).toContain('Status');
    expect(text).toContain('OK');
    expect(text).toContain('Action');

    const headerActions = root.root.find((node) => node.props?.className === 'mobile-card-header-actions');
    const footerActions = root.root.find((node) => node.props?.className === 'mobile-card-footer-actions');
    const stackedField = root.root.find((node) => node.props?.className === 'mobile-field is-stacked');
    const compactCard = root.root.find((node) => node.props?.className === 'mobile-card is-compact');

    expect(headerActions).toBeTruthy();
    expect(footerActions).toBeTruthy();
    expect(stackedField).toBeTruthy();
    expect(compactCard).toBeTruthy();
  });
});
