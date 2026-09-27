import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** Where the daemon keeps its connection secret: next to the settings file, as apps/daemon/src/shell/access.ts does. */
function tokenFile(mode: string) {
  const { NOVA_SETTINGS_FILE } = loadEnv(mode, ROOT, 'NOVA_'); // the repo's .env, which the daemon reads too
  return join(dirname(resolve(ROOT, expand(NOVA_SETTINGS_FILE || '~/.nova/settings.json'))), 'run', 'ws-token');
}

/**
 * Nova's window, served by this dev server, carries the daemon's connection secret - as the page
 * the daemon serves itself does - so it can connect. Only while developing (never in a build), and
 * read afresh for every page, in case the daemon made a new one.
 */
function daemonToken(): Plugin {
  let file = '';
  return {
    name: 'nova-daemon-token',
    apply: 'serve',
    configResolved(config) {
      file = tokenFile(config.mode);
    },
    transformIndexHtml() {
      let token = '';
      try {
        token = readFileSync(file, 'utf8').trim();
      } catch {
        // the daemon hasn't run yet: the page connects once it's reloaded
      }
      return /^[A-Za-z0-9_-]{43}$/.test(token) ? [{ tag: 'meta', attrs: { name: 'nova-token', content: token }, injectTo: 'head-prepend' }] : [];
    },
  };
}

export default defineConfig({
  plugins: [react(), daemonToken()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // The page holds the daemon's secret: other pages on this Mac may neither read it (no CORS) nor frame it.
    cors: false,
    headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', outDir: 'dist' },
});
