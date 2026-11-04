// End-to-end tests: the built app in headless Chrome.
//
//   npm run e2e                  build the site, serve it, run every spec
//   npm run e2e -- --no-build    reuse the last build in e2e-dist/
//   npm run e2e -- ledger help   only the specs whose file name has these words
//   npm run e2e -- --url https://kmezlabs.github.io/kmezBooks/app/   against a published copy
//
// Each spec gets a fresh Chrome profile, so specs don't share companies,
// settings or the service worker. A failing step saves a screenshot to
// e2e-results/. Exits 1 if anything failed.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { serve } from './lib/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const filters = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--url');
const SITE_DIR = join(root, 'e2e-dist');
const RESULTS = join(root, 'e2e-results');

let server;
let appUrl = urlArg;
if (!appUrl) {
  if (!flag('--no-build')) {
    console.log('Building the site into e2e-dist/ …');
    const r = spawnSync(
      process.execPath,
      ['scripts/build-pages.mjs', '--out', join(SITE_DIR, 'kmezBooks')],
      {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  server = await serve(SITE_DIR);
  appUrl = `${server.url}/kmezBooks/app/`;
}

const specs = readdirSync(join(here, 'specs'))
  .filter((f) => f.endsWith('.e2e.mjs'))
  .filter((f) => !filters.length || filters.some((w) => f.includes(w)))
  .sort();

rmSync(RESULTS, { recursive: true, force: true });
let failed = 0;
let passed = 0;
for (const file of specs) {
  const spec = await import(new URL(`./specs/${file}`, import.meta.url));
  console.log(`\n${spec.title} (${file})`);
  const profile = mkdtempSync(join(tmpdir(), 'kmezbooks-e2e-'));
  let browser;
  try {
    browser = await launch(profile);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${e.message}`);
    continue;
  }
  const { page } = browser;
  const t = {
    page,
    app: appUrl,
    site: appUrl.replace(/app\/$/, ''),
    async step(name, fn) {
      const started = Date.now();
      try {
        const note = await fn();
        passed++;
        console.log(`  ✓ ${name}${note ? ` — ${note}` : ''} (${Date.now() - started} ms)`);
      } catch (e) {
        failed++;
        console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
        try {
          mkdirSync(RESULTS, { recursive: true });
          const base = join(
            RESULTS,
            `${file.replace('.e2e.mjs', '')}-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}`,
          );
          writeFileSync(`${base}.png`, await page.screenshot());
          writeFileSync(`${base}.txt`, await page.text());
        } catch {
          // the page may be gone
        }
        throw e;
      }
    },
  };
  try {
    await spec.run(t);
  } catch {
    // reported by step(); the rest of this spec depends on the failed step
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
await server?.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`Screenshots and page text of failures: e2e-results/`);
process.exit(failed ? 1 : 0);
