import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'EasyBooks',
        short_name: 'EasyBooks',
        description:
          'Double-entry bookkeeping for your companies, stored in folders on your own disk.',
        theme_color: '#1f4e79',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
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
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'db/tests/**/*.test.ts'],
    // Each worker process compiles SQLite's WebAssembly, which needs a burst of
    // memory; one reused worker keeps that to a single compile. The suite is
    // small and tests don't rely on module isolation.
    isolate: false,
    maxWorkers: 1,
  },
});
