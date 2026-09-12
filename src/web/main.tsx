import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.js';
// Self-hosted Inter font (bundled locally instead of Google Fonts CDN) so it
// works offline and does not require loosening the strict CSP.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';
import 'katex/dist/katex.min.css';
import { ensureFormFieldNames } from './ensureFormFieldNames.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

// Vite fires `vite:preloadError` when a lazy-loaded chunk fails to fetch — a
// weak mobile network, or a long-lived tab whose assets were replaced by a
// redeploy. Reload once to pick up the current asset names instead of letting
// the rejected import unmount the whole app into a blank page.
const PRELOAD_ERROR_RELOAD_KEY = 'metapi:preload-error-reload-at';
const PRELOAD_ERROR_RELOAD_COOLDOWN_MS = 30_000;

window.addEventListener('vite:preloadError', (event) => {
  let lastReloadAt = 0;
  try {
    lastReloadAt = Number(window.sessionStorage.getItem(PRELOAD_ERROR_RELOAD_KEY) || 0);
  } catch {
    // Session storage may be unavailable; fall through and reload anyway.
  }
  if (Date.now() - lastReloadAt < PRELOAD_ERROR_RELOAD_COOLDOWN_MS) {
    // Just reloaded and a chunk still failed; let the error reach the boundary.
    return;
  }
  event.preventDefault();
  try {
    window.sessionStorage.setItem(PRELOAD_ERROR_RELOAD_KEY, String(Date.now()));
  } catch {
    // Ignore; worst case a later failure reloads again.
  }
  window.location.reload();
});

// Give every form control an id/name so Chrome stops raising the autofill
// advisory; safe no-op for controls that already declare one.
ensureFormFieldNames();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
