// Builds the GitHub Pages site (hosting decided Nov 1, 2026):
//   /kmezBooks/        the home page, from site/
//   /kmezBooks/app/    the app, built with KMB_BASE so it runs from that path
//   /kmezBooks/guide/  the user guide, rendered from docs/USER-GUIDE.md
// plus the GPL text and the third-party licenses the app ships with.
// A broken link on the home page or in the guide fails the build.
//
// Usage: node scripts/build-pages.mjs [--out <dir>] [--base <path>]
//   --out   where to put the site (default pages-dist)
//   --base  the path the site is served from (default /kmezBooks/)

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const out = resolve(root, arg('--out', 'pages-dist'));
const base = arg('--base', '/kmezBooks/').replace(/\/?$/, '/');
const problems = [];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// ---- the app ----

const vite = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules/vite/bin/vite.js'),
    'build',
    '--outDir',
    join(out, 'app'),
    '--emptyOutDir',
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, KMB_BASE: `${base}app/` } },
);
if (vite.status !== 0) process.exit(vite.status ?? 1);

// ---- the home page and the license ----

cpSync(join(root, 'site'), out, { recursive: true });
cpSync(join(root, 'public/icons'), join(out, 'icons'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(out, 'license.txt'));

// ---- the user guide ----

/** GitHub's heading ids, so the guide's own "#…" links work here too. */
function slugger() {
  const seen = new Map();
  return (text) => {
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  };
}

const plain = (html) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const slug = slugger();
const ids = new Set();
const marked = new Marked({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      const id = slug(plain(inner));
      ids.add(id);
      return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
    },
  },
});
const guideHtml = marked.parse(readFileSync(join(root, 'docs/USER-GUIDE.md'), 'utf8'));
const title = plain(/<h1[^>]*>(.*?)<\/h1>/s.exec(guideHtml)?.[1] ?? 'kmezBooks user guide');

for (const [, id] of guideHtml.matchAll(/href="#([^"]*)"/g)) {
  if (!ids.has(decodeURIComponent(id))) problems.push(`guide: "#${id}" matches no heading`);
}

mkdirSync(join(out, 'guide'), { recursive: true });
writeFileSync(
  join(out, 'guide/index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#1f4e79" />
    <link rel="icon" type="image/png" href="../icons/icon-192.png" />
    <link rel="stylesheet" href="../site.css" />
    <title>${title}</title>
  </head>
  <body>
    <header class="top">
      <div class="wrap">
        <a class="brand" href="../"><img src="../icons/icon-192.png" alt="" />kmezBooks</a>
        <nav>
          <a href="../">Home</a>
          <a href="../app/">Open kmezBooks</a>
        </nav>
      </div>
    </header>
    <main class="wrap guide">
${guideHtml}
    </main>
  </body>
</html>
`,
);

// ---- third-party licenses (MIT and Apache ask for their notices to travel with copies) ----

/** The app's runtime packages, and the packages they depend on. */
function runtimePackages() {
  const found = new Map();
  const visit = (name, from) => {
    // Node's lookup: the nearest node_modules up from the package that needs it
    for (let dir = from; ; dir = dirname(dir)) {
      const pkgDir = join(dir, 'node_modules', name);
      if (existsSync(join(pkgDir, 'package.json'))) {
        if (found.has(pkgDir)) return;
        const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
        found.set(pkgDir, pkg);
        for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pkgDir);
        return;
      }
      if (dirname(dir) === dir) {
        problems.push(`licenses: package "${name}" isn't installed`);
        return;
      }
    }
  };
  const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const dep of Object.keys(app.dependencies ?? {})) visit(dep, root);
  // Bundled by vite-plugin-pwa: the service worker and its registration
  for (const dep of ['workbox-window', 'workbox-core', 'workbox-precaching', 'workbox-routing'])
    visit(dep, root);
  return [...found].sort(([, a], [, b]) => a.name.localeCompare(b.name));
}

/** Packages published without a license file, with what their own README and code say. */
const NO_LICENSE_FILE = {
  '@sqlite.org/sqlite-wasm':
    'The package is licensed under the Apache License, Version 2.0 (its README); the full\n' +
    'text is in this file under comlink. SQLite itself is in the public domain:\n' +
    'https://sqlite.org/copyright.html',
};

const notices = runtimePackages().map(([dir, pkg]) => {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (!file && !NO_LICENSE_FILE[pkg.name])
    problems.push(`licenses: ${pkg.name} has no license file`);
  const text = file ? readFileSync(join(dir, file), 'utf8').trim() : NO_LICENSE_FILE[pkg.name];
  return `${pkg.name} ${pkg.version} (${pkg.license ?? 'see below'})\n${'-'.repeat(60)}\n${text}\n`;
});
writeFileSync(
  join(out, 'app/third-party-licenses.txt'),
  `kmezBooks includes the following open source packages. kmezBooks itself is\nlicensed under the GNU General Public License, version 3 or later.\n\n${notices.join('\n\n')}`,
);

// ---- links on the home page ----

const home = readFileSync(join(out, 'index.html'), 'utf8');
for (const [, href] of home.matchAll(/(?:href|src)="([^"]+)"/g)) {
  if (/^[a-z]+:/i.test(href)) continue;
  const [path, anchor] = href.split('#');
  const file = join(out, path, !path || path.endsWith('/') ? 'index.html' : '');
  if (!existsSync(file)) problems.push(`home page: "${href}" points at nothing`);
  else if (anchor && path === 'guide/' && !ids.has(anchor))
    problems.push(`home page: "${href}" matches no heading in the guide`);
}

if (problems.length) {
  console.error(`\nThe site has problems:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nSite built in ${out} for ${base}`);
