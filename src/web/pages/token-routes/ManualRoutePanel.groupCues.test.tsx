import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ManualRoutePanel from './ManualRoutePanel.js';
import type { RouteSummaryRow } from './types.js';

vi.mock('../../i18n.js', () => ({ tr: (text: string) => text }));
vi.mock('../../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  hashColor: () => ({ bg: '', text: '' }),
  normalizeBrandIconKey: (key: string) => key,
}));

type Route = RouteSummaryRow & { id: number };

function route(over: Partial<Route> & { id: number }): Route {
  return {
    modelPattern: '',
    displayName: null,
    displayIcon: null,
    routeMode: 'pattern',
    enabled: true,
    sourceRouteIds: [],
    channelCount: 3,
    enabledChannelCount: 3,
    cooldownChannelCount: 0,
    siteNames: [],
    modelMapping: null,
    ...over,
  } as Route;
}

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

function findButton(root: ReactTestInstance, text: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button'
    && typeof node.props.onClick === 'function'
    && collectText(node).includes(text)
  ));
}

const FORM = {
  routeMode: 'explicit_group' as const,
  displayName: '',
  displayIcon: '',
  modelPattern: '',
  sourceRouteIds: [] as number[],
  advancedOpen: false,
};

function render(routes: Route[], form = FORM, samples: string[] = []) {
  const allRoutes = routes as unknown as RouteSummaryRow[];
  return create(
    <MemoryRouter>
      <ManualRoutePanel
        show
        editingRouteId={null}
        form={form}
        setForm={() => {}}
        saving={false}
        canSave={false}
        routeIconSelectOptions={[]}
        previewModelSamples={samples}
        exactSourceRouteOptions={allRoutes}
        sourceEndpointTypesByRouteId={{}}
        knownRoutes={allRoutes}
        onEditGroup={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('ManualRoutePanel group cues', () => {
  it('shows the two group types as one segmented control', () => {
    const panel = render([]);
    const text = collectText(panel.root);
    expect(text).toContain('聚合已有模型');
    expect(text).toContain('按规则匹配');
    // The old dialog stacked three near-identical explanatory cards.
    expect(text).not.toContain('使用模型匹配规则创建群组');
  });

  it('marks source models that already belong to a group', () => {
    const group = route({
      id: 19047,
      routeMode: 'explicit_group',
      displayName: 'deepseek-v4.1-flash',
      modelPattern: 'deepseek-v4.1-flash',
      sourceRouteIds: [11970],
    });
    const exact = route({ id: 11970, modelPattern: 'deepseek-v4.1-flash' });
    const panel = render([group, exact]);

    act(() => { findButton(panel.root, '选择来源模型').props.onClick(); });

    const text = collectText(panel.root);
    expect(text).toContain('已在 #19047');
  });

  it('blocks creation and offers to edit the group that owns the name', () => {
    const group = route({
      id: 19047,
      routeMode: 'explicit_group',
      displayName: 'deepseek-v4.1-flash',
      modelPattern: 'deepseek-v4.1-flash',
      sourceRouteIds: [11970],
    });
    const exact = route({ id: 11970, modelPattern: 'deepseek-v4.1-flash' });
    const panel = render([group, exact], { ...FORM, displayName: 'deepseek-v4.1-flash' });
    const text = collectText(panel.root);
    expect(text).toContain('已有群组 #19047');
    expect(text).toContain('改为编辑');
  });

  it('only notes a same-name exact route instead of blocking', () => {
    const exact = route({ id: 11970, modelPattern: 'glm-5.3' });
    const panel = render([exact], { ...FORM, displayName: 'glm-5.3' });
    const text = collectText(panel.root);
    expect(text).toContain('#11970');
    expect(text).not.toContain('已有群组');
  });

  it('warns that an upstream model of the same name loses its own route', () => {
    // No exact route yet, but the availability list still offers this name:
    // rebuild will not create a route for it once the group owns the alias.
    const panel = render([], { ...FORM, displayName: 'glm-5.3' }, ['glm-5.3', 'kimi-k3']);
    const text = collectText(panel.root);
    expect(text).toContain('上游当前也提供这个名字');
  });
});
