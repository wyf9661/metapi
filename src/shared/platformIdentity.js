export const PLATFORM_ALIASES = {
  anyrouter: 'anyrouter',
  'wong-gongyi': 'new-api',
  'vo-api': 'new-api',
  'super-api': 'new-api',
  'rix-api': 'new-api',
  'neo-api': 'new-api',
  newapi: 'new-api',
  'new api': 'new-api',
  'new-api': 'new-api',
  oneapi: 'one-api',
  'one api': 'one-api',
  'one-api': 'one-api',
  onehub: 'one-hub',
  'one-hub': 'one-hub',
  donehub: 'done-hub',
  'done-hub': 'done-hub',
  veloera: 'veloera',
  sub2api: 'sub2api',
  openai: 'openai',
  codex: 'codex',
  'chatgpt-codex': 'codex',
  'chatgpt codex': 'codex',
  anthropic: 'claude',
  claude: 'claude',
  gemini: 'gemini',
  'gemini-cli': 'gemini-cli',
  antigravity: 'antigravity',
  'anti-gravity': 'antigravity',
  google: 'gemini',
  cliproxyapi: 'cliproxyapi',
  cpa: 'cliproxyapi',
  'cli-proxy-api': 'cliproxyapi',
};

export function normalizePlatformAlias(platform) {
  const raw = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  if (!raw) return '';
  return PLATFORM_ALIASES[raw] ?? raw;
}

export function detectPlatformByUrlHint(url) {
  const normalized = (url || '').trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized.includes('api.openai.com')) return 'openai';
  if (normalized.includes('chatgpt.com/backend-api/codex')) return 'codex';
  if (normalized.includes('api.anthropic.com') || normalized.includes('anthropic.com/v1')) return 'claude';
  if (
    normalized.includes('generativelanguage.googleapis.com')
    || normalized.includes('googleapis.com/v1beta/openai')
    || normalized.includes('gemini.google.com')
  ) {
    return 'gemini';
  }
  if (normalized.includes('cloudcode-pa.googleapis.com')) return 'gemini-cli';
  if (normalized.includes('anyrouter')) return 'anyrouter';
  if (normalized.includes('donehub') || normalized.includes('done-hub')) return 'done-hub';
  if (normalized.includes('onehub') || normalized.includes('one-hub')) return 'one-hub';
  if (normalized.includes('veloera')) return 'veloera';
  if (normalized.includes('sub2api')) return 'sub2api';
  if (normalized.includes('127.0.0.1:8317') || normalized.includes('localhost:8317')) return 'cliproxyapi';

  return undefined;
}
