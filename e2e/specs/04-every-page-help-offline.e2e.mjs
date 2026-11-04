// Every page opens without errors and its ? shows the right sections of the
// user guide (CO-9); help closes when the page or the company changes; the
// installed app works offline. The pages and their sections are read from
// Workspace.tsx and helpTopics.ts, so this follows the code.

import { readFileSync } from 'node:fs';

export const title = 'Every page, its help and offline (CO-9)';

const PASSPHRASE = 'e2e help passphrase';
const src = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

/** Workspace.tsx's PAGES: page key → sidebar label */
const PAGES = Object.fromEntries(
  [
    ...src('app/Workspace.tsx')
      .match(/const PAGES = \{([\s\S]*?)\}/)[1]
      .matchAll(/(\w+): '([^']+)'/g),
  ].map((m) => [m[1], m[2]]),
);
/** helpTopics.ts: page key → the guide heading ids its ? shows */
const TOPICS = Object.fromEntries(
  [...src('app/helpTopics.ts').matchAll(/^\s+(\w+): \[([^\]]*)\]/gm)].map((m) => [
    m[1],
    [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  ]),
);

const open = `!!document.querySelector('.help-panel')`;
const closed = `!document.querySelector('.help-panel')`;
/** The ids of the sections the panel shows, in order */
const shownIds = (page) =>
  page.js(
    `[...document.querySelectorAll('.help-body h2[id], .help-body h3[id]')].map((h) => h.id)`,
  );
const moduleBox = (name) =>
  `[...document.querySelectorAll('.module-list label')].find((l) => l.querySelector('strong').textContent === ${JSON.stringify(name)}).querySelector('input')`;

function expectTopics(ids, want, where) {
  if (ids[0] !== want[0] || want.some((w) => !ids.includes(w))) {
    throw new Error(`${where}: wanted ${want.join(', ')}; shown ${ids.slice(0, 6).join(', ')}`);
  }
}

export async function run({ page, app, step }) {
  await step('start screen: ? shows Getting started and Companies', async () => {
    await page.open(app);
    await page.js(`document.querySelector('.start-header .help-button').click(), true`);
    await page.waitFor(open);
    expectTopics(await shownIds(page), TOPICS.start, 'start screen');
  });

  await step('a test company with every module on; the start-screen help closes', async () => {
    await page.click('New company…', { scope: 'document' });
    await page.fill('Legal name', 'Help Test LLC');
    await page.fill('Your name (owner)', 'Pat Owner');
    await page.fill('Passphrase', PASSPHRASE);
    await page.fill('Repeat it', PASSPHRASE);
    await page.check('Test company', true);
    await page.nextFolder('help');
    await page.click('Choose folder and create');
    await page.waitFor(
      `document.querySelector('.company-name')?.textContent === 'Help Test LLC – Test'`,
    );
    await page.waitFor(closed, 3_000);
    await page.nav('Company');
    await page.waitFor(`!!document.querySelector('.module-list input')`);
    for (const m of [
      'Customers and sales',
      'Vendors and bills',
      'Banking',
      'QuickBooks migration',
    ]) {
      if (!(await page.js(`${moduleBox(m)}.checked`))) {
        await page.js(`(${moduleBox(m)}.click(), true)`);
        await page.waitFor(
          `${moduleBox(m)}.checked && ![...document.querySelectorAll('.module-list input')].some((i) => i.disabled)`,
        );
      }
    }
    const sidebar = await page.js(
      `[...document.querySelectorAll('.sidebar button.tab')].map((b) => b.textContent)`,
    );
    const missing = Object.values(PAGES).filter((p) => !sidebar.includes(p));
    if (missing.length) throw new Error(`not in the sidebar: ${missing.join(', ')}`);
    return `${sidebar.length} pages`;
  });

  for (const [key, label] of Object.entries(PAGES)) {
    await step(`${label}: opens, and ? shows ${TOPICS[key].join(', ')}`, async () => {
      const before = page.problems.length;
      await page.nav(label);
      await page.waitFor(
        `document.querySelector('.sidebar [aria-current=page]')?.textContent === ${JSON.stringify(label)} && document.querySelector('main')?.innerText.trim().length > 0`,
      );
      // Help from the previous page closes when you go to another one
      await page.waitFor(closed, 3_000);
      await page.js(`document.querySelector('.topbar .help-button').click(), true`);
      await page.waitFor(open);
      expectTopics(await shownIds(page), TOPICS[key], label);
      if (page.problems.length > before) throw new Error(page.problems.slice(before).join('\n'));
    });
  }

  await step('Close company closes help too', async () => {
    await page.click('Close company', { exact: true, scope: 'document' });
    await page.waitFor(
      `!document.querySelector('.company-name') && !!document.querySelector('.start-header')`,
    );
    await page.waitFor(closed, 3_000);
  });

  await step('no console errors or failed requests', async () => {
    const all = [...page.problems, ...page.badRequests];
    if (all.length) throw new Error(all.join('\n'));
  });

  await step(
    'offline: after the service worker has taken over, the app and its help load with no network',
    async () => {
      await page.waitFor(
        `(window.__sw ??= navigator.serviceWorker.ready.then(() => (window.__swReady = true)), !!window.__swReady)`,
        30_000,
      );
      await page.reload();
      await page.waitFor(`!!navigator.serviceWorker.controller`, 30_000);
      page.offline = true;
      await page.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page.reload();
      await page.waitFor(`!!document.querySelector('.start-header .help-button')`, 30_000);
      await page.js(`document.querySelector('.start-header .help-button').click(), true`);
      await page.waitFor(open);
      expectTopics(await shownIds(page), TOPICS.start, 'offline start screen');
      // The company opened earlier is still in the recent list
      if (!(await page.has('Help Test LLC'))) throw new Error('the recent list is empty offline');
    },
  );
}
