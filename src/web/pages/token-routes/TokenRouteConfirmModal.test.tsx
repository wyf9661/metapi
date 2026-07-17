import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import TokenRouteConfirmModal, { type TokenRouteConfirmState } from './TokenRouteConfirmModal.js';

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

describe('TokenRouteConfirmModal', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders React content safely and confirms with the dismiss checkbox state', async () => {
    const onConfirm = vi.fn();
    const state: TokenRouteConfirmState = {
      title: '确认移除通道',
      description: <>模型「<strong>{'<script>alert(1)</script>'}</strong>」</>,
      confirmText: '确认移除',
      tone: 'danger',
      dismissLabel: '以后不再提示',
    };
    let root!: WebTestRenderer;

    await act(async () => {
      root = create(
        <TokenRouteConfirmModal state={state} onCancel={vi.fn()} onConfirm={onConfirm} />,
      );
    });

    expect(collectText(root.root)).toContain('<script>alert(1)</script>');
    const checkbox = root.root.findByType('input');
    await act(async () => checkbox.props.onChange({ target: { checked: true } }));
    const confirmButton = root.root.findAllByType('button').find((button) => collectText(button) === '确认移除');
    await act(async () => confirmButton?.props.onClick());
    expect(onConfirm).toHaveBeenCalledWith(true);
    root.unmount();
  });

  it('cancels through the shared centered modal footer', async () => {
    const onCancel = vi.fn();
    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <TokenRouteConfirmModal
          state={{ title: '确认站点屏蔽', description: '说明', confirmText: '确认屏蔽', tone: 'warning' }}
          onCancel={onCancel}
          onConfirm={vi.fn()}
        />,
      );
    });
    const cancelButton = root.root.findAllByType('button').find((button) => collectText(button) === '取消');
    await act(async () => cancelButton?.props.onClick());
    expect(onCancel).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
