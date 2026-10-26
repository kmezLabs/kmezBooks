import { describe, expect, it } from 'vitest';
import { OpenCompany } from './company';
import { readAuditEvents } from './companyData';
import { COMPANY_FILE } from './companyFolder';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

const FAST = 1_000;

describe('open company: create, save, reopen (DF-1, DF-2, US-1)', () => {
  it('creates a company, saves changes and reopens them with the passphrase', async () => {
    const dir = new FakeDir();
    const { company } = await OpenCompany.create(asDir(dir), ACME, 'pass phrase', FAST);
    const { id } = company.info();
    company.db.exec(`UPDATE company SET city = 'Chicago'`);
    expect(company.dirty).toBe(true);
    await company.save();
    expect(company.dirty).toBe(false);
    company.close();

    const { company: reopened } = await OpenCompany.open(asDir(dir), 'pass phrase');
    expect(reopened.info()).toMatchObject({ id, legalName: 'Acme LLC' });
    expect(reopened.db.selectValue('SELECT city FROM company')).toBe('Chicago');
    reopened.close();
  });

  it('records creation and every unlock in the audit log, stamped with the owner (US-5)', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), ACME, 'pw', FAST)).company.close();
    const { company } = await OpenCompany.open(asDir(dir), 'pw', { device: 'Office PC' });
    const actions = readAuditEvents(company.db).map((e) => [e.action, e.entity, e.user, e.note]);
    expect(actions[0]).toEqual(['unlock', null, 'Pat Owner', 'Office PC']);
    expect(actions).toContainEqual(['create_company', null, 'Pat Owner', null]);
    expect(actions).toContainEqual(['insert', 'company', 'Pat Owner', null]);
    // The unlock entry is unsaved until the autosave writes it
    expect(company.dirty).toBe(true);
    company.close();
  });

  it('never stores the database unencrypted', async () => {
    const dir = new FakeDir();
    const { company } = await OpenCompany.create(
      asDir(dir),
      { ...ACME, legalName: 'Plaintext Check LLC' },
      'pw',
      FAST,
    );
    company.close();
    const raw = Buffer.from(dir.files.get(COMPANY_FILE)!.data);
    expect(raw.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(raw.includes(Buffer.from('Plaintext Check LLC'))).toBe(false);
  });

  it('refuses a wrong passphrase', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), ACME, 'right', FAST)).company.close();
    await expect(OpenCompany.open(asDir(dir), 'wrong')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
  });

  it('refuses invalid details before writing anything', async () => {
    const dir = new FakeDir();
    await expect(
      OpenCompany.create(asDir(dir), { ...ACME, ein: '123', ownerName: ' ' }, 'pw', FAST),
    ).rejects.toThrow(/EIN must look like 12-3456789.*owner's name/);
    expect(dir.files.has(COMPANY_FILE)).toBe(false);
  });

  it('refuses to create a company in a folder that already has one', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), ACME, 'pw', FAST)).company.close();
    await expect(OpenCompany.create(asDir(dir), ACME, 'pw', FAST)).rejects.toMatchObject({
      name: 'CompanyExistsError',
    });
  });

  it('refuses to save over a file another copy saved in the meantime (DF-3)', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), ACME, 'pw', FAST)).company.close();
    const { company: a } = await OpenCompany.open(asDir(dir), 'pw');
    const { company: b } = await OpenCompany.open(asDir(dir), 'pw');
    b.db.exec(`UPDATE company SET legal_name = 'Saved by B'`);
    await b.save();
    a.db.exec(`UPDATE company SET legal_name = 'Saved by A'`);
    await expect(a.save()).rejects.toMatchObject({ name: 'FileChangedOnDiskError' });

    const { company: check } = await OpenCompany.open(asDir(dir), 'pw');
    expect(check.info().legalName).toBe('Saved by B');
  });

  it('opens read-only: SQLite itself refuses writes, and save is refused', async () => {
    const dir = new FakeDir();
    (await OpenCompany.create(asDir(dir), ACME, 'pw', FAST)).company.close();
    const { company } = await OpenCompany.open(asDir(dir), 'pw', { readOnly: true });
    expect(company.dirty).toBe(false);
    expect(() => company.db.exec(`UPDATE company SET city = 'x'`)).toThrow(/readonly|query_only/i);
    await expect(company.save()).rejects.toMatchObject({ name: 'ReadOnlyError' });
  });
});
