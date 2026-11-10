import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';

// The floating card is portalled to document.body; render it inline so the test
// can assert on it (same convention as mobile-drawer.test.tsx).
vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

import ActualModelTrigger from './ActualModelTrigger.js';
import { ModelBadge } from './BrandIcon.js';

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findTrigger(root: WebTestRenderer) {
  return root.root.findAll((node) => node.props?.['data-testid'] === 'actual-model-trigger');
}

function clickWrapper(root: WebTestRenderer) {
  const wrapper = root.root.findAll((node) => (
    node.type === 'span' && typeof node.props.onClick === 'function'
  ))[0];
  expect(wrapper).toBeDefined();
  act(() => {
    wrapper!.props.onClick({ stopPropagation: () => {} });
  });
}

describe('ActualModelTrigger', () => {
  it('stays hidden when the request went upstream under the requested name', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(<ActualModelTrigger requestedModel="deepseek-v4.1-flash" actualModel="deepseek-v4.1-flash" />);
    });
    expect(findTrigger(root)).toHaveLength(0);
  });

  it('stays hidden when the log has no actual model', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(<ActualModelTrigger requestedModel="deepseek-v4.1-flash" actualModel={null} />);
    });
    expect(findTrigger(root)).toHaveLength(0);
  });

  it('shows the route glyph once the model was routed to another name', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(<ActualModelTrigger requestedModel="deepseek-v4.1-flash" actualModel="deepseek-v4-flash" />);
    });
    const trigger = findTrigger(root);
    expect(trigger).toHaveLength(1);
    expect(trigger[0]!.props['aria-label']).toContain('deepseek-v4-flash');
  });

  it('floats the request/actual pair on click and closes on the next click', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(<ActualModelTrigger requestedModel="deepseek-v4.1-flash" actualModel="deepseek-v4-flash" />);
    });

    expect(root.root.findAll((node) => node.props?.['data-testid'] === 'actual-model-popover')).toHaveLength(0);

    clickWrapper(root);
    const cards = root.root.findAll((node) => node.props?.['data-testid'] === 'actual-model-popover');
    expect(cards).toHaveLength(1);
    const text = collectText(cards[0]!);
    expect(text).toContain('请求模型');
    expect(text).toContain('deepseek-v4.1-flash');
    expect(text).toContain('实际模型');
    expect(text).toContain('deepseek-v4-flash');

    // Tapping again dismisses it — the same glyph toggles the card.
    clickWrapper(root);
    expect(root.root.findAll((node) => node.props?.['data-testid'] === 'actual-model-popover')).toHaveLength(0);
  });

  it('shows the response model when the upstream answered as another model', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(
        <ActualModelTrigger
          requestedModel="deepseek-v4.1-flash"
          actualModel="deepseek-v4.1-flash"
          responseModel="deepseek-v4.1-flash-1017"
        />,
      );
    });
    // Routing kept the name, but the relay answered as a different model — that
    // is exactly what the log should expose.
    expect(findTrigger(root)).toHaveLength(1);
    expect(findTrigger(root)[0]!.props['aria-label']).toContain('deepseek-v4.1-flash-1017');

    clickWrapper(root);
    const cards = root.root.findAll((node) => node.props?.['data-testid'] === 'actual-model-popover');
    expect(cards).toHaveLength(1);
    const text = collectText(cards[0]!);
    expect(text).toContain('响应模型');
    expect(text).toContain('deepseek-v4.1-flash-1017');
    // Nothing was routed, so the actual-model row must not appear.
    expect(text).not.toContain('实际模型');
  });

  it('stays hidden when the response model matches the requested one', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(
        <ActualModelTrigger
          requestedModel="deepseek-v4.1-flash"
          actualModel="deepseek-v4.1-flash"
          responseModel="deepseek-v4.1-flash"
        />,
      );
    });
    expect(findTrigger(root)).toHaveLength(0);
  });
});

describe('ModelBadge with a routed model', () => {
  it('keeps the route glyph outside the model chip', () => {
    let root!: WebTestRenderer;
    act(() => {
      root = create(<ModelBadge model="deepseek-v4.1-flash" actualModel="deepseek-v4-flash" />);
    });

    const chip = root.root.findAll((node) => (
      node.type === 'span' && typeof node.props.style?.border === 'string'
    ))[0];
    expect(chip).toBeDefined();
    // The chip stays exactly what it renders everywhere else: brand icon + name.
    expect(collectText(chip!)).toBe('deepseek-v4.1-flash');
    expect(chip!.findAll((node) => node.props?.['data-testid'] === 'actual-model-trigger')).toHaveLength(0);
    expect(findTrigger(root)).toHaveLength(1);
  });
});
