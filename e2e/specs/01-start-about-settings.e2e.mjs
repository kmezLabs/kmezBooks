// The start screen, About (CO-8) and Settings with themes (CO-10).

export const title = 'Start screen, About and Settings (CO-8, CO-10)';

const SITE = 'https://kmezlabs.github.io/kmezBooks/';
const dialog = `!!document.querySelector('.dialog')`;
const noDialog = `!document.querySelector('.dialog')`;
const escape = `document.querySelector('.dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`;

export async function run({ page, app, step }) {
  await step('the start screen opens with no errors', async () => {
    await page.open(app);
    await page.waitFor(`!!document.querySelector('.start-header')`);
    for (const b of ['Open company folder…', 'New company…', 'Restore from backup…']) {
      if (!(await page.has(b))) throw new Error(`no ${b}`);
    }
  });

  await step('About shows the build, privacy, links and the license', async () => {
    await page.click('About', { scope: `document.querySelector('.start-header')` });
    await page.waitFor(dialog);
    const text = await page.js(`document.querySelector('.dialog').innerText`);
    const build = await page.js(
      `document.querySelector('.status-version').textContent.match(/build (\\w+)/)?.[1] ?? ''`,
    );
    for (const s of [
      `built from commit ${build}`,
      'Your books never leave your computer',
      'No telemetry',
      'Copyright (C) 2026 kmezLabs',
      'GNU General Public License, version 3 or later',
    ]) {
      if (!text.includes(s)) throw new Error(`About is missing: ${s}`);
    }
    const links = await page.js(
      `[...document.querySelectorAll('.dialog a')].map((a) => [a.textContent, a.href, a.target])`,
    );
    const want = [
      ['Home page', SITE, '_blank'],
      ['User guide', `${SITE}guide/`, '_blank'],
      ['Source code on GitHub', 'https://github.com/kmezLabs/kmezBooks', '_blank'],
      ['License', `${SITE}license.txt`, '_blank'],
      ['Third-party licenses', `${SITE}app/third-party-licenses.txt`, '_blank'],
    ];
    if (JSON.stringify(links) !== JSON.stringify(want)) throw new Error(JSON.stringify(links));
    await page.js(escape);
    await page.waitFor(noDialog);
    return `build ${build}`;
  });

  await step(
    'Settings: a theme applies at once and is set before the app runs on reload',
    async () => {
      await page.js(`document.querySelector('.start-header .settings-button').click(), true`);
      await page.waitFor(dialog);
      const themes = await page.js(
        `[...document.querySelectorAll('.theme-card .theme-name')].map((n) => n.textContent.trim())`,
      );
      if (themes.join('|') !== 'System|Light|Dark|Grey|High contrast|Warm')
        throw new Error(themes.join('|'));
      const background = () => page.js(`getComputedStyle(document.body).backgroundColor`);
      const light = await background();
      await page.js(`document.querySelector('.theme-card input[value="dark"]').click(), true`);
      await page.waitFor(`document.documentElement.dataset.theme === 'dark'`);
      const dark = await background();
      if (dark === light) throw new Error(`the page stayed ${light}`);
      await page.js(escape);
      await page.reload();
      // index.html's inline script sets the theme before the app's code runs
      if ((await page.js(`document.documentElement.dataset.theme`)) !== 'dark') {
        throw new Error('the theme was lost on reload');
      }
      await page.js(`document.querySelector('.start-header .settings-button').click(), true`);
      await page.waitFor(dialog);
      await page.js(`document.querySelector('.theme-card input[value="system"]').click(), true`);
      await page.waitFor(`!document.documentElement.dataset.theme`);
      await page.js(escape);
      return `${light} → ${dark} and back`;
    },
  );

  await step('no console errors or failed requests', async () => {
    const all = [...page.problems, ...page.badRequests];
    if (all.length) throw new Error(all.join('\n'));
  });
}
