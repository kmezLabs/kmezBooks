import { describe, expect, it } from 'vitest';
import { accountId, newLedgerDb, post } from '../../db/tests/ledgerTestDb';
import { changeEntry, voidEntry } from '../ledger/postEntry';
import { ATTACHMENT_DIR } from './attachments';
import { BACKUP_DIR } from './backups';
import { checkBackup } from './backupDrill';
import { CompanySession } from './companySession';
import { deserializeDatabase, loadSqlite, serializeDatabase, type Database } from './sqlite';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

const later = () => new Promise((r) => setTimeout(r, 5));
const found = async () => true;

/** A copy of the database as it is now, as a backup would hold it. */
async function snapshot(db: Database): Promise<Database> {
  const sqlite3 = await loadSqlite();
  return deserializeDatabase(sqlite3, serializeDatabase(sqlite3, db));
}

describe('restore drill (M8, DF-10)', () => {
  it('ties a backup out with the live books as they were, despite later work', async () => {
    const live = await newLedgerDb();
    post(live, '2026-01-05', 'Utilities', 'Checking', 45_10);
    const meals = post(live, '2026-01-06', 'Meals', 'Checking', 12_00);
    const backup = await snapshot(live);
    await later();
    // After the backup: a new entry, and a void of an entry it holds
    post(live, '2026-01-07', 'Rent or Lease', 'Checking', 900_00);
    voidEntry(live, meals, null);

    const check = await checkBackup(backup, live, found);
    expect(check).toMatchObject({
      ok: true,
      integrity: 'ok',
      upgradeError: null,
      sameCompany: true,
      entries: 2,
      liveEntries: 2,
      differences: [],
      attachments: 0,
    });
    expect(check.changesSince).toBeGreaterThan(0);
  });

  it('shows entries changed in place since the backup as differences', async () => {
    const live = await newLedgerDb();
    live.exec('UPDATE company SET posted_edits = 1');
    const id = post(live, '2026-01-05', 'Utilities', 'Checking', 45_10);
    const backup = await snapshot(live);
    await later();
    changeEntry(live, id, {
      date: '2026-01-05',
      lines: [
        { accountId: accountId(live, 'Utilities'), debit: 50_00, credit: 0 },
        { accountId: accountId(live, 'Checking'), debit: 0, credit: 50_00 },
      ],
    });
    const check = await checkBackup(backup, live, found);
    expect(check.ok).toBe(false);
    expect(check.differences).toEqual([
      { account: 'Checking', backup: -45_10, live: 0 },
      { account: 'Utilities', backup: 45_10, live: 0 },
    ]);
  });

  it('checks a real backup through the session: passphrase, attachments, nothing written', async () => {
    const dir = new FakeDir();
    let t = new Date(2026, 9, 28, 9, 0, 0);
    const session = new CompanySession({
      iterations: 1_000,
      heartbeatMs: 0,
      saveDelayMs: 10_000,
      now: () => t,
    });
    await session.create(asDir(dir), ACME, 'the passphrase', 'PC');
    const acct = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const id = await session.postJournalEntry({
      date: '2026-03-01',
      lines: [
        { accountId: acct('Meals'), debit: 25_00, credit: 0 },
        { accountId: acct('Checking'), debit: 0, credit: 25_00 },
      ],
    });
    const a = await session.addAttachment('journal_entry', String(id), new File(['r'], 'r.pdf'));
    t = new Date(t.getTime() + 60_000);
    await session.backupNow();
    const newest = (await session.listBackups()).sort((x, y) => y.name.localeCompare(x.name))[0];
    const before = session.status().dirty;

    expect(await session.testBackup(newest!.name, 'the passphrase')).toMatchObject({
      ok: true,
      legalName: 'Acme LLC',
      entries: 1,
      attachments: 1,
      missingAttachments: [],
    });
    expect(session.status().dirty).toBe(before);
    await expect(session.testBackup(newest!.name, 'wrong')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });

    // The company folder's copy alone is enough; with neither, it's missing
    dir.dirs.get(BACKUP_DIR)!.dirs.get(ATTACHMENT_DIR)!.files.delete(`${a.id}.kma`);
    expect((await session.testBackup(newest!.name, 'the passphrase')).ok).toBe(true);
    dir.dirs.get(ATTACHMENT_DIR)!.files.delete(`${a.id}.kma`);
    expect(await session.testBackup(newest!.name, 'the passphrase')).toMatchObject({
      ok: false,
      missingAttachments: ['r.pdf'],
    });
  });
});
