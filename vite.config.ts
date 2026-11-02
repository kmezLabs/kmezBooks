import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The version and build shown in the status bar (CO-6): package.json's
// version, and the commit and date this build came from
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
function build(): string {
  try {
    const commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${commit} ${day}`;
  } catch {
    return 'dev';
  }
}

// Where the app is served from: '/' on this computer (localhost:4180), and
// '/kmezBooks/app/' on GitHub Pages, set by scripts/build-pages.mjs
const base = process.env.KMB_BASE ?? '/';

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_BUILD__: JSON.stringify(build()),
  },
  plugins: [
    react(),
    VitePWA({
      // A new version waits until the owner updates, after saving (M8)
      registerType: 'prompt',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'kmezBooks',
        short_name: 'kmezBooks',
        description:
          'Double-entry bookkeeping for your companies, stored in folders on your own disk.',
        theme_color: '#1f4e79',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // sqlite3.wasm must be precached for offline use
        globPatterns: ['**/*.{js,css,html,wasm,png,svg}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Opening a file by its address (third-party-licenses.txt) must show
        // the file, not the app: only addresses without a file name fall back
        // to index.html.
        navigateFallbackDenylist: [/\/[^/?]*\.[^/?]*(\?|$)/],
      },
      // The dev service worker is opt-in (PWA_DEV=1): generating it needs a
      // burst of memory, and nothing in development depends on it.
      devOptions: { enabled: process.env.PWA_DEV === '1', type: 'module' },
    }),
  ],
  // The SQLite package loads its own .wasm file; pre-bundling breaks that.
  // No COOP/COEP headers are needed because we don't use OPFS.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  // The owner's app is served from here (the installed PWA and its recent
  // folders belong to this exact address), so it never drifts to another port
  preview: { port: 4180, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'db/tests/**/*.test.ts'],
    // Each worker process compiles SQLite's WebAssembly, which needs a burst of
    // memory; one reused worker keeps that to a single compile. The suite is
    // small and tests don't rely on module isolation.
    isolate: false,
    maxWorkers: 1,
    // The on-disk module cache doesn't notice a new file in db/migrations
    // (schema.ts finds them with import.meta.glob), so tests would silently
    // run without the newest migration. The suite is fast enough without it.
    fsModuleCache: false,
  },
});
