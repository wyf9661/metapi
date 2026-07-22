export type SiteCustomHeaderField = {
  key: string;
  value: string;
};

export type SiteApiEndpointField = {
  draftId?: string;
  url: string;
  enabled: boolean;
  cooldownUntil?: string | null;
  lastFailureReason?: string | null;
};

export type SiteForm = {
  name: string;
  url: string;
  platform: string;
  proxyUrl: string;
  useSystemProxy: boolean;
  apiEndpoints: SiteApiEndpointField[];
  customHeaders: SiteCustomHeaderField[];
  customHeadersOverrideRequestHeaders: boolean;
  globalWeight: string;
  protocolProfile: {
    preferResponses: boolean;
    requireCodexClient: boolean;
    credentialMode: string;
  };
};

export type SiteEditorState =
  | { mode: 'add' }
  | { mode: 'edit'; editingSiteId: number };

export type SiteSavePayload = {
  name: string;
  url: string;
  platform: string;
  initializationPresetId?: string | null;
  proxyUrl: string;
  useSystemProxy: boolean;
  apiEndpoints: Array<{
    url: string;
    enabled: boolean;
    sortOrder: number;
  }>;
  customHeaders: string;
  customHeadersOverrideRequestHeaders: boolean;
  globalWeight: number;
  protocolProfile?: string | null;
  postRefreshProbeEnabled?: boolean;
  postRefreshProbeModel?: string;
  postRefreshProbeScope?: 'single' | 'all';
  postRefreshProbeLatencyThresholdMs?: number;
};

type SiteSaveAction =
  | { kind: 'add'; payload: SiteSavePayload }
  | { kind: 'update'; id: number; payload: SiteSavePayload };

export function emptySiteCustomHeader(): SiteCustomHeaderField {
  return { key: '', value: '' };
}


/** Preset used by “Codex 客户端” checkbox for NewAPI codex-only gateways. */
export const CODEX_CLIENT_PROFILE_HEADERS = {
  'User-Agent': 'codex_cli_rs/0.39.0',
  originator: 'codex_cli_rs',
} as const;

export function isCodexClientProfileEnabled(fields: SiteCustomHeaderField[]): boolean {
  const map = new Map<string, string>();
  for (const field of fields) {
    const key = field.key.trim().toLowerCase();
    if (!key) continue;
    map.set(key, field.value.trim());
  }
  const ua = (map.get('user-agent') || '').toLowerCase();
  const originator = (map.get('originator') || '').toLowerCase();
  const looksCodexUa = (
    ua.includes('codex_cli_rs')
    || ua.includes('openai-codex')
    || ua.includes('codex_vscode')
    || ua.includes('codex_chatgpt_desktop')
    || ua.startsWith('codex')
  );
  const looksCodexOriginator = originator.includes('codex');
  return looksCodexUa || looksCodexOriginator;
}

export function applyCodexClientProfile(
  fields: SiteCustomHeaderField[],
  enabled: boolean,
): SiteCustomHeaderField[] {
  const presetEntries = Object.entries(CODEX_CLIENT_PROFILE_HEADERS);
  const presetKeys = new Set(presetEntries.map(([key]) => key.toLowerCase()));

  // Drop empty rows and previous preset keys first when toggling.
  const kept = fields.filter((field) => {
    const key = field.key.trim();
    const value = field.value;
    if (!key && !value.trim()) return false;
    if (!key) return true;
    if (!enabled && presetKeys.has(key.toLowerCase())) {
      // Only remove known preset keys when disabling.
      const lower = key.toLowerCase();
      if (lower === 'user-agent') {
        const v = value.trim().toLowerCase();
        return !(
          v.includes('codex_cli_rs')
          || v.includes('openai-codex')
          || v === CODEX_CLIENT_PROFILE_HEADERS['User-Agent'].toLowerCase()
        );
      }
      if (lower === 'originator') {
        const v = value.trim().toLowerCase();
        return !v.includes('codex');
      }
    }
    if (enabled && presetKeys.has(key.toLowerCase())) {
      // Replace existing preset keys below.
      return false;
    }
    return true;
  });

  if (!enabled) {
    return kept.length > 0 ? kept : [emptySiteCustomHeader()];
  }

  const next = [
    ...presetEntries.map(([key, value]) => ({ key, value })),
    ...kept,
  ];
  return next.length > 0 ? next : [emptySiteCustomHeader()];
}

/** Keep the user-facing Codex switch's transport and protocol settings in sync. */
export function isCodexCompatibilityModeEnabled(form: Pick<SiteForm, 'customHeaders' | 'protocolProfile'>): boolean {
  return isCodexClientProfileEnabled(form.customHeaders)
    || form.protocolProfile.preferResponses
    || form.protocolProfile.requireCodexClient;
}

export function applyCodexCompatibilityMode(form: SiteForm, enabled: boolean): SiteForm {
  return {
    ...form,
    customHeaders: applyCodexClientProfile(form.customHeaders, enabled),
    customHeadersOverrideRequestHeaders: enabled
      ? true
      : form.customHeadersOverrideRequestHeaders,
    protocolProfile: {
      ...form.protocolProfile,
      preferResponses: enabled,
      requireCodexClient: enabled,
    },
  };
}


export function emptySiteApiEndpoint(): SiteApiEndpointField {
  return {
    url: '',
    enabled: true,
    cooldownUntil: null,
    lastFailureReason: null,
  };
}

function ensureSiteCustomHeaderRows(rows: SiteCustomHeaderField[]): SiteCustomHeaderField[] {
  return rows.length > 0 ? rows : [emptySiteCustomHeader()];
}

export function emptySiteForm(): SiteForm {
  return {
    name: '',
    url: '',
    platform: '',
    proxyUrl: '',
    useSystemProxy: false,
    apiEndpoints: [emptySiteApiEndpoint()],
    customHeaders: [emptySiteCustomHeader()],
    customHeadersOverrideRequestHeaders: false,
    protocolProfile: { preferResponses: false, requireCodexClient: false, credentialMode: 'auto' },
    globalWeight: '1',
  };
}

function ensureSiteApiEndpointRows(rows: SiteApiEndpointField[]): SiteApiEndpointField[] {
  return rows.length > 0 ? rows : [emptySiteApiEndpoint()];
}

function parseCustomHeadersForEditor(raw: unknown): SiteCustomHeaderField[] {
  if (typeof raw !== 'string') {
    return ensureSiteCustomHeaderRows([]);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return ensureSiteCustomHeaderRows([]);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return ensureSiteCustomHeaderRows([]);
    }
    return ensureSiteCustomHeaderRows(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : String(value ?? ''),
      })),
    );
  } catch {
    return ensureSiteCustomHeaderRows([]);
  }
}

function parseApiEndpointsForEditor(raw: unknown): SiteApiEndpointField[] {
  if (!Array.isArray(raw)) {
    return ensureSiteApiEndpointRows([]);
  }

  const rows: SiteApiEndpointField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    rows.push({
      url: typeof row.url === 'string' ? row.url : '',
      enabled: row.enabled !== false,
      cooldownUntil: typeof row.cooldownUntil === 'string' ? row.cooldownUntil : null,
      lastFailureReason: typeof row.lastFailureReason === 'string' ? row.lastFailureReason : null,
    });
  }
  return ensureSiteApiEndpointRows(rows);
}

export function siteFormFromSite(site: Partial<Omit<SiteForm, 'apiEndpoints' | 'customHeaders' | 'customHeadersOverrideRequestHeaders' | 'globalWeight' | 'proxyUrl' | 'useSystemProxy'>> & {
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  customHeadersOverrideRequestHeaders?: boolean | null;
  apiEndpoints?: Array<{
    url?: string | null;
    enabled?: boolean | null;
    cooldownUntil?: string | null;
    lastFailureReason?: string | null;
  }> | null;
  customHeaders?: string | null;
  globalWeight?: number | string | null;
}): SiteForm {
  const globalWeightRaw = Number(site.globalWeight);
  const globalWeight = Number.isFinite(globalWeightRaw) && globalWeightRaw > 0 ? String(globalWeightRaw) : '1';
  return {
    name: site.name ?? '',
    url: site.url ?? '',
    platform: site.platform ?? '',
    proxyUrl: site.proxyUrl ?? '',
    useSystemProxy: !!site.useSystemProxy,
    apiEndpoints: parseApiEndpointsForEditor(site.apiEndpoints),
    customHeaders: parseCustomHeadersForEditor(site.customHeaders),
    customHeadersOverrideRequestHeaders: !!site.customHeadersOverrideRequestHeaders,
    protocolProfile: (() => {
      try {
        const raw = typeof (site as any).protocolProfile === 'string' ? JSON.parse((site as any).protocolProfile) : null;
        return {
          preferResponses: !!raw?.preferResponses,
          requireCodexClient: !!raw?.requireCodexClient,
          credentialMode: raw?.credentialMode || 'auto',
        };
      } catch { return { preferResponses: false, requireCodexClient: false, credentialMode: 'auto' }; }
    })(),
    globalWeight,
  };
}

// Keep this in sync with normalizeSiteApiEndpointBaseUrl in
// src/server/services/siteApiEndpointService.ts.
function normalizeSiteApiEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function serializeSiteCustomHeaders(fields: SiteCustomHeaderField[]): {
  valid: boolean;
  customHeaders: string;
  error?: string;
} {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const field of fields) {
    const key = field.key.trim();
    const value = field.value;
    const hasAnyInput = key.length > 0 || value.trim().length > 0;
    if (!hasAnyInput) continue;
    if (!key) {
      return { valid: false, customHeaders: '', error: '请求头名称不能为空' };
    }
    const normalizedKey = key.toLowerCase();
    if (seen.has(normalizedKey)) {
      return { valid: false, customHeaders: '', error: `请求头 "${key}" 重复了` };
    }
    seen.add(normalizedKey);
    headers[key] = value;
  }

  return {
    valid: true,
    customHeaders: Object.keys(headers).length > 0 ? JSON.stringify(headers) : '',
  };
}

export function serializeSiteApiEndpoints(fields: SiteApiEndpointField[]): {
  valid: boolean;
  apiEndpoints: Array<{
    url: string;
    enabled: boolean;
    sortOrder: number;
  }>;
  error?: string;
} {
  const apiEndpoints: Array<{
    url: string;
    enabled: boolean;
    sortOrder: number;
  }> = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const rawUrl = field.url.trim();
    if (!rawUrl) continue;
    const normalizedUrl = normalizeSiteApiEndpointUrl(rawUrl);
    if (!normalizedUrl) continue;
    if (seen.has(normalizedUrl)) {
      return {
        valid: false,
        apiEndpoints: [],
        error: `API 请求地址 "${normalizedUrl}" 重复了`,
      };
    }
    seen.add(normalizedUrl);
    apiEndpoints.push({
      url: normalizedUrl || rawUrl,
      enabled: field.enabled !== false,
      sortOrder: apiEndpoints.length,
    });
  }

  return {
    valid: true,
    apiEndpoints,
  };
}

export function buildSiteSaveAction(editor: SiteEditorState, form: SiteSavePayload): SiteSaveAction {
  if (editor.mode === 'edit') {
    if (!Number.isFinite(editor.editingSiteId)) {
      throw new Error('editingSiteId is required in edit mode');
    }
    return { kind: 'update', id: editor.editingSiteId, payload: form };
  }
  return { kind: 'add', payload: form };
}
