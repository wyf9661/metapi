// Applies the persisted (or system-preferred) theme before first paint so the
// UI never flashes the wrong theme. Served as a same-origin static file so the
// strict CSP (script-src 'self') allows it without needing 'unsafe-inline'.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
