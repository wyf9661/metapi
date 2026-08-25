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

// Give every form control an id/name so Chrome stops raising the autofill
// advisory; safe no-op for controls that already declare one.
ensureFormFieldNames();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
