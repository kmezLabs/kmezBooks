// Banking through its screens: import a .qbo statement into the review queue
// (BK-1, BK-3), and import it again without adding anything twice (BK-6).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const title = 'Banking: statement import and duplicates (BK-1, BK-3, BK-6)';

const PASSPHRASE = 'e2e banking passphrase';

/** A made-up .qbo (OFX 1.x SGML with the Intuit header), three transactions */
function qbo() {
  const txn = (id, date, amount, name) =>
    `<STMTTRN>\n<TRNTYPE>${amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}\n<DTPOSTED>${date}120000.000[-5:EST]\n<TRNAMT>${amount}\n<FITID>${id}\n<NAME>${name}\n</STMTTRN>`;
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260131120000.000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>111000025
<ACCTID>1234567890
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101120000.000[-5:EST]
<DTEND>20260131120000.000[-5:EST]
${txn('E2E-1', '20260105', '2500.00', 'TENANT CO RENT')}
${txn('E2E-2', '20260112', '-45.00', 'POWER CO')}
${txn('E2E-3', '20260120', '-12.34', 'OFFICE DEPOT')}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>2442.66
<DTASOF>20260131120000.000[-5:EST]
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
}

const moduleBox = (name) =>
  `[...document.querySelectorAll('.module-list label')].find((l) => l.querySelector('strong').textContent === ${JSON.stringify(name)}).querySelector('input')`;
const forReview = `[...document.querySelectorAll('main button')].find((b) => b.textContent.startsWith('For review'))?.textContent`;

export async function run({ page, app, step }) {
  const dir = mkdtempSync(join(tmpdir(), 'kmezbooks-e2e-qbo-'));
  const file = join(dir, 'Checking_January.qbo');
  writeFileSync(file, qbo());
  try {
    await step('a company with the standard chart and the Banking module on', async () => {
      await page.open(app);
      await page.click('New company…');
      await page.fill('Legal name', 'Acme LLC');
      await page.fill('Your name (owner)', 'Pat Owner');
      await page.fill('Passphrase', PASSPHRASE);
      await page.fill('Repeat it', PASSPHRASE);
      await page.check('Start with the standard chart of accounts', true);
      await page.nextFolder('banking');
      await page.click('Choose folder and create');
      await page.waitFor(`document.querySelector('.company-name')?.textContent === 'Acme LLC'`);
      await page.nav('Company');
      await page.waitFor(`!!document.querySelector('.module-list input')`);
      if (!(await page.js(`${moduleBox('Banking')}.checked`))) {
        await page.js(`(${moduleBox('Banking')}.click(), true)`);
        await page.waitFor(`${moduleBox('Banking')}.checked`);
      }
      await page.nav('Bank import');
      await page.waitFor(`!!document.querySelector('main input[type=file]')`);
    });

    const importFile = async () => {
      await page.setFiles('main input[type=file]', [file]);
      await page.waitFor(
        `document.querySelector('.dialog h2')?.textContent === 'Import statements'`,
      );
      const dialog = `document.querySelector('.dialog')`;
      // The account is remembered after the first import
      const chosen = await page.js(`${dialog}.querySelector('.combo input').value`);
      if (!chosen) await page.pick(`${dialog}.querySelector('.combo input')`, 'Checking');
      await page.click('Import', { exact: true });
      await page.waitFor(
        `!document.querySelector('.dialog') && !!document.querySelector('main .notice')`,
      );
      return page.js(`document.querySelector('main .notice').textContent`);
    };

    await step('import a .qbo: its three transactions wait for review (BK-1, BK-3)', async () => {
      const notice = await importFile();
      await page.waitFor(`${forReview} === 'For review (3)'`);
      const rows = await page.js(`document.querySelector('main').innerText`);
      for (const name of ['TENANT CO RENT', 'POWER CO', 'OFFICE DEPOT']) {
        if (!rows.includes(name)) throw new Error(`${name} is not in the queue`);
      }
      return notice;
    });

    await step('importing the same file again adds nothing (BK-6)', async () => {
      const notice = await importFile();
      if (!notice.includes('already imported')) throw new Error(notice);
      await page.waitFor(`${forReview} === 'For review (3)'`);
      return notice;
    });

    await step('no console errors or failed requests', async () => {
      const all = [...page.problems, ...page.badRequests];
      if (all.length) throw new Error(all.join('\n'));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
