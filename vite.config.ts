import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolveDevProxyTarget } from './src/web/devProxyTarget';
import { readFileSync } from 'node:fs';

const packageVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = resolveDevProxyTarget(env);
  console.log(`[vite] dev proxy target: ${proxyTarget} (web version ${packageVersion})`);

  const frontendPort = Number.parseInt(env.FRONTEND_PORT || env.VITE_FRONTEND_PORT || '', 10);
  const resolvedFrontendPort = Number.isFinite(frontendPort) && frontendPort > 0 ? frontendPort : 5173;
  const frontendHost = (env.VITE_DEV_HOST || '127.0.0.1').trim() || '127.0.0.1';

  return {
    root: 'src/web',
    plugins: [react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(packageVersion),
    },
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
      rollupOptions: {
        output: {},
      },
    },
    server: {
      host: frontendHost,
      port: resolvedFrontendPort,
      proxy: {
        '^/api($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '^/monitor-proxy($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
        '^/v1($|/)': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
