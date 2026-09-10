import { describe, expect, it } from 'vitest';
import {
  resolveProxyLogClientDisplay,
  truncateProxyLogClientName,
} from './proxyLogsHelpers.js';

describe('proxy log client display', () => {
  it('shows the downstream User-Agent as-is when it is short enough', () => {
    const display = resolveProxyLogClientDisplay({
      clientFamily: 'generic',
      clientAppName: 'MyOwnTool/1.2.3',
      clientConfidence: 'heuristic',
    });

    expect(display.primary).toBe('MyOwnTool/1.2.3');
    expect(display.fullName).toBe('MyOwnTool/1.2.3');
    expect(display.heuristic).toBe(true);
  });

  it('trims long User-Agents and keeps the full value for the tooltip', () => {
    const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    const display = resolveProxyLogClientDisplay({
      clientFamily: 'generic',
      clientAppName: userAgent,
      clientConfidence: 'heuristic',
    });

    expect(display.primary?.length ?? 0).toBeLessThanOrEqual(44);
    expect(display.primary?.endsWith('…')).toBe(true);
    expect(display.fullName).toBe(userAgent);
    expect(truncateProxyLogClientName('short/1.0')).toBe('short/1.0');
  });

  it('does not repeat the "generic" family under a detected client', () => {
    const display = resolveProxyLogClientDisplay({
      clientFamily: 'generic',
      clientAppName: 'MyOwnTool/1.2.3',
      clientConfidence: 'heuristic',
    });

    expect(display.secondary).toBeNull();
  });

  it('does not badge the raw User-Agent fallback as a guess', () => {
    const display = resolveProxyLogClientDisplay({
      clientFamily: 'generic',
      clientAppName: 'OpenAI/Python 2.24.0',
      clientConfidence: 'user_agent',
    });

    expect(display.primary).toBe('OpenAI/Python 2.24.0');
    expect(display.heuristic).toBe(false);
  });

  it('keeps the guess badge for identities inferred from weak signals', () => {
    const display = resolveProxyLogClientDisplay({
      clientFamily: 'generic',
      clientAppName: 'OpenCode',
      clientConfidence: 'heuristic',
    });

    expect(display.heuristic).toBe(true);
  });

  it('keeps a meaningful family label as the secondary line', () => {
    const display = resolveProxyLogClientDisplay({
      clientFamily: 'codex',
      clientAppName: 'Codex CLI',
      clientConfidence: 'exact',
    });

    expect(display.primary).toBe('Codex CLI');
    expect(display.secondary).toBe('Codex');
    expect(display.heuristic).toBe(false);
  });

  it('falls back to the family label when no client app is known', () => {
    const display = resolveProxyLogClientDisplay(
      { clientFamily: 'generic', clientAppName: null, clientConfidence: null },
      { includeGeneric: true },
    );

    expect(display.primary).toBe('通用');
    expect(display.fullName).toBeNull();
  });
});
