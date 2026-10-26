import { describe, expect, it } from 'vitest';
import { OpenCompany } from './company';
import { COMPANY_FILE } from './companyFolder';
import { FakeDir, asDir } from './testing/fakeDir';

const FAST = 1_000;

describe('open company: create, save, reopen (DF-1, DF-2, US-1)', () => {
  it('creates a company, saves changes and reopens them with the passphrase', async () => {
    const dir = new FakeDir();
    const { company } = await OpenCompany.create(asDir(dir), 'pass phrase', 'Acme LLC', FAST);
    const { id } = company.info();
    company.db.exec(`UPDATE company SET ein = '12-3456789'`);
    await company.save();
    company.close();

    const { company: reopened } = await OpenCompany.open(asDir(dir), 'pass phrase');
    expect(reopened.info()).toMatchObject({ id, legalName: 'Acme LLC' });
    expect(reopened.db.selectValue('SELECT ein FROM company')).toBe('12-3456789');
    reopened.close();
  });

  it('never stores the database unencrypted', async () => {
    const dir = new FakeDir();
    const { company } = await OpenCompany.create(asDir(dir), 'pw', 'Plaintext Check LLC', FAST);
    company.close();
    const raw = Buffer.from(dir.files.get(COMPANY_FILE)!.data);
    expect(raw.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(raw.includes(Buffer.from('Plaintext Check LLC'))).toBe(false);
  });

  it('refuses a wrong passphrase', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), 'right', 'Acme LLC', FAST)).company.close();
    await expect(OpenCompany.open(asDir(dir), 'wrong')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
  });

  it('refuses to create a company in a folder that already has one', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), 'pw', 'First', FAST)).company.close();
    await expect(OpenCompany.create(asDir(dir), 'pw', 'Second', FAST)).rejects.toMatchObject({
      name: 'CompanyExistsError',
    });
  });

  it('refuses to save over a file another copy saved in the meantime (DF-3)', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), 'pw', 'Acme LLC', FAST)).company.close();
    const { company: a } = await OpenCompany.open(asDir(dir), 'pw');
    const { company: b } = await OpenCompany.open(asDir(dir), 'pw');
    b.db.exec(`UPDATE company SET legal_name = 'Saved by B'`);
    await b.save();
    a.db.exec(`UPDATE company SET legal_name = 'Saved by A'`);
    await expect(a.save()).rejects.toMatchObject({ name: 'FileChangedOnDiskError' });

    const { company: check } = await OpenCompany.open(asDir(dir), 'pw');
    expect(check.info().legalName).toBe('Saved by B');
  });
});
