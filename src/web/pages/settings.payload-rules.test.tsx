import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getModelTokenCandidates: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Settings payload rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'interval',
      checkinIntervalHours: 6,
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      proxyFirstByteTimeoutSec: 0,
      routingWeights: {},
      tokenRouterFailureCooldownMaxSec: 30 * 24 * 60 * 60,
      adminIpAllowlist: [],
      systemProxyUrl: '',
      payloadRules: {
        override: [
          {
            models: [{ name: 'gpt-*', protocol: 'codex' }],
            params: {
              'reasoning.effort': 'high',
            },
          },
        ],
      },
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({
      success: true,
      payloadRules: {
        default: [],
        defaultRaw: [],
        override: [
          {
            models: [{ name: 'gpt-*', protocol: 'codex' }],
            params: {
              'reasoning.effort': 'high',
            },
          },
        ],
        overrideRaw: [],
        filter: [],
      },
    });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads saved payload rules into the editor', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const overrideTextarea = root.root.find((node) => (
        node.type === 'textarea'
        && node.props['aria-label'] === 'Payload 规则 override'
      ));

      expect(String(overrideTextarea.props.value)).toContain('"reasoning.effort": "high"');
    } finally {
      root?.unmount();
    }
  });

  it('fills the default section when applying the Codex default high-reasoning preset', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const presetButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === 'Codex 默认高推理'
      ));

      await act(async () => {
        presetButton.props.onClick();
      });

      const defaultTextarea = root.root.find((node) => (
        node.type === 'textarea'
        && node.props['aria-label'] === 'Payload 规则 default'
      ));

      expect(String(defaultTextarea.props.value)).toContain('"reasoning.effort": "high"');
      expect(String(defaultTextarea.props.value)).toContain('"protocol": "codex"');
    } finally {
      root?.unmount();
    }
  });

  it('saves parsed payload rules through updateRuntimeSettings', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const overrideRawTextarea = root.root.find((node) => (
        node.type === 'textarea'
        && node.props['aria-label'] === 'Payload 规则 override-raw'
      ));

      await act(async () => {
        overrideRawTextarea.props.onChange({
          target: {
            value: `[
  {
    "models": [{ "name": "gpt-*", "protocol": "codex" }],
    "params": {
      "response_format": "{\\"type\\":\\"json_schema\\"}"
    }
  }
]`,
          },
        });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存 Payload 规则'
      ));

      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
        payloadRules: {
          override: [
            {
              models: [{ name: 'gpt-*', protocol: 'codex' }],
              params: {
                'reasoning.effort': 'high',
              },
            },
          ],
          'override-raw': [
            {
              models: [{ name: 'gpt-*', protocol: 'codex' }],
              params: {
                response_format: '{"type":"json_schema"}',
              },
            },
          ],
        },
      });
    } finally {
      root?.unmount();
    }
  });

  it('saves a rule created from the visual builder', async () => {
    apiMock.getRuntimeSettings.mockResolvedValueOnce({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'interval',
      checkinIntervalHours: 6,
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      proxyFirstByteTimeoutSec: 0,
      routingWeights: {},
      tokenRouterFailureCooldownMaxSec: 30 * 24 * 60 * 60,
      adminIpAllowlist: [],
      systemProxyUrl: '',
      payloadRules: {},
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const addButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '新增规则'
      ));

      await act(async () => {
        addButton.props.onClick();
      });

      const modelInput = root.root.find((node) => (
        node.type === 'input'
        && node.props['aria-label'] === 'Payload 规则可视化模型 1'
      ));
      const pathInput = root.root.find((node) => (
        node.type === 'input'
        && node.props['aria-label'] === 'Payload 规则可视化路径 1'
      ));
      const valueInput = root.root.find((node) => (
        node.props['aria-label'] === 'Payload 规则可视化值 1'
      ));

      await act(async () => {
        modelInput.props.onChange({ target: { value: 'gpt-*' } });
        pathInput.props.onChange({ target: { value: 'reasoning.effort' } });
        valueInput.props.onChange({ target: { value: 'high' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存 Payload 规则'
      ));

      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
        payloadRules: {
          default: [
            {
              models: [{ name: 'gpt-*' }],
              params: {
                'reasoning.effort': 'high',
              },
            },
          ],
          'default-raw': [],
          override: [],
          'override-raw': [],
          filter: [],
        },
      });
    } finally {
      root?.unmount();
    }
  });

  it('keeps the full payload-rule protocol option set in the visual editor', async () => {
    apiMock.getRuntimeSettings.mockResolvedValueOnce({
      checkinCron: '0 8 * * *',
      checkinScheduleMode: 'interval',
      checkinIntervalHours: 6,
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '15 4 * * *',
      logCleanupUsageLogsEnabled: true,
      logCleanupProgramLogsEnabled: true,
      logCleanupRetentionDays: 14,
      routingFallbackUnitCost: 1,
      proxyFirstByteTimeoutSec: 0,
      routingWeights: {},
      tokenRouterFailureCooldownMaxSec: 30 * 24 * 60 * 60,
      adminIpAllowlist: [],
      systemProxyUrl: '',
      payloadRules: {},
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const addButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '新增规则'
      ));

      await act(async () => {
        addButton.props.onClick();
      });

      const protocolSelect = root.root.find((node) => (
        node.props['data-testid'] === 'payload-rule-protocol-1'
      ));
      const options = Array.isArray(protocolSelect.props.options)
        ? protocolSelect.props.options
        : [];
      const values = options.map((option: { value: string }) => option.value);

      expect(values).toEqual(expect.arrayContaining([
        '',
        'sub2api',
        'new-api',
        'one-api',
        'gemini-cli',
        'anyrouter',
      ]));
    } finally {
      root?.unmount();
    }
  });

  it('blocks save when a payload-rule section contains invalid JSON', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider>
              <Settings />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const filterTextarea = root.root.find((node) => (
        node.type === 'textarea'
        && node.props['aria-label'] === 'Payload 规则 filter'
      ));

      await act(async () => {
        filterTextarea.props.onChange({ target: { value: '[' } });
      });

      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '保存 Payload 规则'
      ));

      await act(async () => {
        saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRuntimeSettings).not.toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });
});
