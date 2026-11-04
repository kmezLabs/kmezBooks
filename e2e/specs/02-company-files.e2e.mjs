// A company is an encrypted folder (DF-1, DF-2): create one, see what is in the
// folder while it is open (the lock, DF-4) and after closing it, and open it
// again from the recent list with its passphrase (US-1).

export const title = 'Company files: create, close, reopen (DF-1, DF-2, DF-4, US-1)';

const PASSPHRASE = 'e2e correct horse battery';

/** Names in a folder of the browser's private storage, which stands in for the user's disk */
const listFolder = (page, name) =>
  page.js(`(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(${JSON.stringify(name)});
    const out = [];
    for await (const [n] of dir.entries()) out.push(n);
    return out.sort();
  })()`);

export async function run({ page, app, step }) {
  await step('create a company in an empty folder', async () => {
    await page.open(app);
    await page.click('New company…');
    await page.fill('Legal name', 'Acme LLC');
    await page.fill('Your name (owner)', 'Pat Owner');
    await page.fill('Passphrase', PASSPHRASE);
    await page.fill('Repeat it', PASSPHRASE);
    await page.nextFolder('acme');
    await page.click('Choose folder and create');
    await page.waitFor(`document.querySelector('.company-name')?.textContent === 'Acme LLC'`);
    await page.waitFor(
      `/^(Saved|All changes saved)/.test(document.querySelector('.save-state')?.textContent ?? '')`,
    );
  });

  await step('while open, the folder holds the encrypted file and a lock', async () => {
    const files = await listFolder(page, 'acme');
    for (const f of ['company.kmb', 'company.lock']) {
      if (!files.includes(f)) throw new Error(`missing ${f}: ${files.join(', ')}`);
    }
    // The company file is encrypted: no SQLite header and no company name in it
    const plain = await page.js(`(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('acme');
      const bytes = new Uint8Array(await (await (await dir.getFileHandle('company.kmb')).getFile()).arrayBuffer());
      const text = new TextDecoder('latin1').decode(bytes);
      return [text.slice(0, 4), text.includes('SQLite format'), text.includes('Acme LLC')];
    })()`);
    if (plain[0] !== 'KMB1' || plain[1] || plain[2]) throw new Error(JSON.stringify(plain));
    return files.join(', ');
  });

  await step('closing saves and removes the lock', async () => {
    await page.click('Close company', { exact: true, scope: 'document' });
    await page.waitFor(
      `!document.querySelector('.company-name') && !!document.querySelector('.start-header')`,
    );
    const files = await listFolder(page, 'acme');
    if (files.includes('company.lock')) throw new Error(`lock left behind: ${files.join(', ')}`);
  });

  await step('the recent list reopens it; a wrong passphrase is refused', async () => {
    await page.click('Acme LLC', { scope: 'document' });
    await page.fill('Passphrase', 'not the passphrase');
    await page.click('Open', { exact: true });
    await page.waitFor(
      `document.querySelector('.dialog .error')?.textContent.includes('Wrong passphrase')`,
    );
    await page.fill('Passphrase', PASSPHRASE);
    await page.click('Open', { exact: true });
    await page.waitFor(`document.querySelector('.company-name')?.textContent === 'Acme LLC'`);
  });

  await step('no console errors or failed requests', async () => {
    const all = [...page.problems, ...page.badRequests];
    if (all.length) throw new Error(all.join('\n'));
  });
}
