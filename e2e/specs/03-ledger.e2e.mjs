// The ledger through its screens: post a journal entry (GL-3), void it (GL-7),
// re-enter it from a filled-in copy (GL-10), add an expense split over two
// categories (EX-1, EX-3), and see it all in the Profit and Loss (RP-2).

import { Page } from '../lib/browser.mjs';

export const title = 'Ledger: journal entries, void, re-enter, expenses, reports';

const PASSPHRASE = 'e2e ledger passphrase';
const year = new Date().getFullYear();

/** The combo box on line `row` of the lines table */
const lineCombo = (row) =>
  `document.querySelectorAll('table.lines tbody tr')[${row}].querySelector('.combo input')`;

/** The open entry's number and its lines as "Account debit credit memo" */
const entryView = (page) =>
  page.js(`(() => {
    const h = document.querySelector('main h2')?.textContent ?? '';
    const table = [...document.querySelectorAll('main table')].find((t) => t.tHead?.textContent.includes('Debit'));
    const rows = table ? [...table.tBodies[0].rows].map((r) => [...r.cells].map((c) => c.textContent.trim()).join(' | ')) : [];
    return { heading: h, rows };
  })()`);

export async function run({ page, app, step }) {
  await step('a new company with the standard chart of accounts', async () => {
    await page.open(app);
    await page.click('New company…');
    await page.fill('Legal name', 'Sample Holdings LLC');
    await page.fill('Your name (owner)', 'Pat Owner');
    await page.fill('Passphrase', PASSPHRASE);
    await page.fill('Repeat it', PASSPHRASE);
    await page.check('Start with the standard chart of accounts', true);
    await page.nextFolder('ledger');
    await page.click('Choose folder and create');
    await page.waitFor(
      `document.querySelector('.company-name')?.textContent === 'Sample Holdings LLC'`,
    );
  });

  let first;
  await step('post a balanced journal entry (GL-3)', async () => {
    await page.nav('Journal entries');
    await page.click('New journal entry');
    await page.fill('Date', `${year}-01-15`);
    await page.fill('Ref', 'JE-1');
    await page.fill('Memo', 'Owner pays for supplies');
    await page.pick(lineCombo(0), 'Office Supplies and Software');
    await page.fillAria('Line 1 debit', '123.45');
    await page.pick(lineCombo(1), 'Checking');
    await page.fillAria('Line 2 credit', '123.45');
    await page.click('Post entry', { exact: true });
    await page.waitFor(
      `/^Journal entry \\d+/.test(document.querySelector('main h2')?.textContent ?? '')`,
    );
    first = await entryView(page);
    if (first.rows.length !== 2 || !first.rows[0].includes('123.45'))
      throw new Error(JSON.stringify(first));
    return first.heading;
  });

  await step('void it with a reason (GL-7)', async () => {
    await page.click('Void entry', { exact: true });
    await page.waitFor(`!!document.querySelector('.dialog')`);
    await page.fill('Reason', 'Wrong account');
    await page.click('Void entry', { exact: true });
    await page.waitFor(
      `!document.querySelector('.dialog') && !!document.querySelector('main h2 .badge')`,
    );
  });

  await step(
    're-enter it: the copy is filled in, and posts as a new entry with the same lines (GL-10)',
    async () => {
      await page.click('Re-enter', { exact: true });
      await page.waitFor(
        `document.querySelector('main h2')?.textContent.startsWith('Re-enter journal entry')`,
      );
      if (!(await page.has('the voided one stays on record'))) throw new Error('no copy notice');
      await page.click('Post entry', { exact: true });
      await page.waitFor(
        `/^Journal entry \\d+$/.test(document.querySelector('main h2')?.textContent.trim() ?? '')`,
      );
      const copy = await entryView(page);
      if (copy.heading === first.heading.replace(/\s*void$/, '')) throw new Error('no new entry');
      if (JSON.stringify(copy.rows) !== JSON.stringify(first.rows)) {
        throw new Error(`lines differ:\n${first.rows.join('\n')}\n---\n${copy.rows.join('\n')}`);
      }
      return `${first.heading.trim()} → ${copy.heading.trim()}`;
    },
  );

  await step('add an expense split over two categories, with no payee (EX-1, EX-3)', async () => {
    await page.nav('Transactions');
    await page.click('Add Transaction', { exact: true });
    await page.waitFor(`!!document.querySelector('form.quick-add')`);
    const form = `document.querySelector('form.quick-add')`;
    await page.fill('Date', `${year}-02-03`, { scope: form });
    await page.fill('Ref / check no.', '1001', { scope: form });
    await page.pick(Page.comboUnder('Paid from', form), 'Checking');
    await page.click('Split', { exact: true, scope: form });
    await page.waitFor(`!!${form}.querySelector('table.lines')`);
    const row = (i) =>
      `${form}.querySelectorAll('table.lines tbody tr')[${i}].querySelector('.combo input')`;
    await page.pick(row(0), 'Office Supplies and Software');
    await page.fillAria('Line 1 amount', '40.00');
    await page.pick(row(1), 'Meals');
    await page.fillAria('Line 2 amount', '10.50');
    await page.click('Add expense', { exact: true, scope: form });
    await page.waitFor(`!document.querySelector('form.quick-add')`);
    await page.waitFor(
      `document.querySelector('table.register-list')?.innerText.includes('50.50')`,
    );
  });

  await step('the Profit and Loss shows both entries’ categories', async () => {
    await page.nav('Reports');
    await page.waitFor(`!!document.querySelector('table.report')`);
    await page.fill('Report', 'pl', { scope: `document.querySelector('.report-controls')` });
    await page.waitFor(
      `document.querySelector('.report-head h2')?.textContent === 'Profit and Loss' && !document.body.innerText.includes('Updating…')`,
    );
    const value = (label) =>
      page.js(
        `(() => { const r = [...document.querySelectorAll('table.report tbody tr')].find((r) => r.cells[0].textContent.trim() === ${JSON.stringify(label)}); return r ? r.cells[r.cells.length - 1].textContent.trim() : null; })()`,
      );
    const supplies = await value('Office Supplies and Software');
    const meals = await value('Meals');
    // 123.45 re-entered (the void counts for nothing) + 40.00 from the split expense
    if (supplies !== '163.45' || meals !== '10.50')
      throw new Error(`supplies ${supplies}, meals ${meals}`);
    return `supplies ${supplies}, meals ${meals}`;
  });

  await step('no console errors or failed requests', async () => {
    const all = [...page.problems, ...page.badRequests];
    if (all.length) throw new Error(all.join('\n'));
  });
}
