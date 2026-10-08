// Applies the persisted (or system-preferred) theme before first paint so the
// UI never flashes the wrong theme. Served as a same-origin static file so the
// strict CSP (script-src 'self') allows it without needing 'unsafe-inline'.
// Mirrors App.resolveStoredThemeMode(): theme_mode ('system'|'light'|'dark')
// wins, the legacy 'theme' key is a fallback, otherwise follow the system.
(function () {
  try {
    var mode = localStorage.getItem('theme_mode');
    if (mode !== 'system' && mode !== 'dark' && mode !== 'light') {
      mode = localStorage.getItem('theme');
    }
    if (mode !== 'dark' && mode !== 'light') {
      mode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', mode);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
