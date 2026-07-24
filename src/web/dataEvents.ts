export const TOKEN_COVERAGE_CHANGED_EVENT = 'metapi:token-coverage-changed';

export type TokenCoverageChangedDetail = {
  accountIds?: number[];
  source?: string;
};

export function emitTokenCoverageChanged(detail: TokenCoverageChangedDetail = {}): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(TOKEN_COVERAGE_CHANGED_EVENT, { detail }));
}
