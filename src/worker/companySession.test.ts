import { describe, expect, it } from 'vitest';
import { BACKUP_DIR, listBackups } from './backups';
import { COMPANY_FILE } from './companyFolder';
import { CompanySession, type SessionDeps } from './companySession';
import { createCompanyKey, encryptDatabase } from './kmbFormat';
import { LOCK_FILE, STALE_AFTER_MS, writeLock } from './lockFile';
import { MIGRATIONS } from './schema';
import { migrate } from './migrations';
import { loadSqlite, openEmptyDatabase, serializeDatabase } from './sqlite';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

const FAST = 1_000;

function newSession(extra: SessionDeps = {}) {
  let t = new Date(2026, 9, 26, 9, 0, 0);
  const statuses: string[] = [];
  const session = new CompanySession({
    iterations: FAST,
    heartbeatMs: 0,
    saveDelayMs: 5,
    now: () => t,
    onStatus: (s) => statuses.push(s.error?.name ?? (s.dirty ? 'dirty' : 'clean')),
    ...extra,
  });
  return {
    session,
    statuses,
    advance: (ms: number) => (t = new Date(t.getTime() + ms)),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backups = async (dir: FakeDir) =>
  (await listBackups(asDir(await dir.getDirectoryHandle(BACKUP_DIR)))).map(
    (b) => b.label ?? 'auto',
  );

async function createdCompany(passphrase = 'pw') {
  const dir = new FakeDir('Acme LLC');
  const { session } = newSession();
  await session.create(asDir(dir), ACME, passphrase, 'Office PC');
  await session.close();
  return dir;
}

describe('company session: create, autosave, close (DF-1, DF-2, DF-9)', () => {
  it('creates a company with a lock file and a first backup', async () => {
    const dir = new FakeDir();
    const { session } = newSession();
    const { status } = await session.create(asDir(dir), ACME, 'pw', 'Office PC');
    expect(status).toMatchObject({
      open: true,
      legalName: 'Acme LLC',
      dirty: false,
      readOnly: false,
    });
    expect(JSON.parse(dir.text(LOCK_FILE))).toMatchObject({
      device: 'Office PC',
      user: 'Pat Owner',
    });
    expect(await backups(dir)).toEqual(['auto']);
    expect(status.backupOverdue).toBe(false);
  });

  it('autosaves shortly after a change', async () => {
    const dir = new FakeDir();
    const { session } = newSession();
    await session.create(asDir(dir), ACME, 'pw', 'Office PC');
    const before = dir.files.get(COMPANY_FILE)!.lastModified;
    session.updateDetails({ city: 'Chicago' });
    expect(session.status().dirty).toBe(true);
    await wait(40);
    expect(session.status().dirty).toBe(false);
    expect(dir.files.get(COMPANY_FILE)!.lastModified).toBeGreaterThan(before);
  });

  it('writes the lock entry on close, removes the lock file, and reopens cleanly', async () => {
    const dir = await createdCompany();
    expect(dir.files.has(LOCK_FILE)).toBe(false);
    const { session } = newSession();
    const outcome = await session.open(asDir(dir), 'pw', { device: 'Laptop' });
    expect(outcome.kind).toBe('opened');
    const actions = session.audit().map((e) => `${e.action}:${e.note ?? ''}`);
    // Newest first: this unlock, then the earlier session's lock
    expect(actions.slice(0, 2)).toEqual(['unlock:Laptop', 'lock:Office PC']);
  });

  it('reports a close once, as closed, without an open "saved" status first (DF-2)', async () => {
    // Pages reload when a save is reported; a report while closing made them
    // ask a company that was gone a moment later ("No company is open")
    const dir = await createdCompany();
    const seen: { open: boolean; saved: string | null }[] = [];
    const { session } = newSession({
      saveDelayMs: 10_000,
      onStatus: (s) => seen.push({ open: s.open, saved: s.lastSavedAt }),
    });
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    session.updateDetails({ city: 'Saved on close' });
    seen.length = 0;
    await session.close();
    expect(seen.map((s) => s.open)).toEqual([false]);

    const check = newSession().session;
    await check.open(asDir(dir), 'pw', { device: 'PC' });
    expect(check.details().city).toBe('Saved on close');
  });

  it('when the save on close fails, stays open and reports why', async () => {
    const dir = await createdCompany();
    const seen: { open: boolean; error: string | null }[] = [];
    const { session } = newSession({
      saveDelayMs: 10_000,
      onStatus: (s) => seen.push({ open: s.open, error: s.error?.name ?? null }),
    });
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    session.updateDetails({ city: 'Not lost' });
    dir.denyAccess = true;
    seen.length = 0;
    await expect(session.close()).rejects.toMatchObject({ name: 'FolderAccessError' });
    expect(seen.at(-1)).toEqual({ open: true, error: 'FolderAccessError' });
    expect(session.status()).toMatchObject({ open: true, dirty: true });
  });

  it('backs up the first save of the day and then every 4 hours, not every save', async () => {
    const dir = new FakeDir();
    const { session, advance } = newSession();
    await session.create(asDir(dir), ACME, 'pw', 'Office PC');
    session.updateDetails({ city: 'A' });
    await session.save();
    advance(60 * 60_000);
    session.updateDetails({ city: 'B' });
    await session.save();
    expect(await backups(dir)).toHaveLength(1);
    advance(3 * 60 * 60_000);
    session.updateDetails({ city: 'C' });
    await session.save();
    expect(await backups(dir)).toHaveLength(2);
  });

  it('refuses invalid details with a readable message and saves nothing', async () => {
    const dir = new FakeDir();
    const { session } = newSession();
    await session.create(asDir(dir), ACME, 'pw', 'Office PC');
    expect(() => session.updateDetails({ state: 'Illinois' })).toThrow(/two-letter code/);
    expect(session.details().state).toBe('IL');
  });

  it('switches modules on and off (CO-4)', async () => {
    const dir = new FakeDir();
    const { session } = newSession();
    await session.create(asDir(dir), ACME, 'pw', 'Office PC');
    // Invoices and bills are opted into; the rest start on
    expect(session.modules()).toEqual({
      sales: false,
      bills: false,
      expenses: true,
      banking: true,
      migration: true,
    });
    session.setModule('banking', false);
    expect(session.modules().banking).toBe(false);
    expect(session.audit()[0]).toMatchObject({ action: 'update', entity: 'company_module' });
  });
});

describe('test companies (CO-7)', () => {
  it('are real companies unless created as a test company', async () => {
    const { session } = newSession();
    const { status } = await session.create(asDir(new FakeDir()), ACME, 'pw', 'Office PC');
    expect(status.test).toBe(false);
    expect(() => session.assertTestCompany()).toThrow(/only in a test company/);
  });

  it('keep the mark after saving and reopening, and allow the technical test', async () => {
    const dir = new FakeDir();
    const first = newSession().session;
    const { status } = await first.create(asDir(dir), { ...ACME, test: true }, 'pw', 'Office PC');
    expect(status.test).toBe(true);
    await first.close();
    const { session } = newSession();
    const outcome = await session.open(asDir(dir), 'pw', { device: 'Office PC' });
    expect(outcome.kind).toBe('opened');
    expect(session.status().test).toBe(true);
    expect(() => session.assertTestCompany()).not.toThrow();
  });

  it('can only be 0 or 1 in the schema', async () => {
    const { session } = newSession();
    await session.create(asDir(new FakeDir()), ACME, 'pw', 'Office PC');
    expect(() => session.current().db.exec('UPDATE company SET test = 2')).toThrow(/CHECK/);
  });
});

describe('one editor at a time (DF-3, DF-4)', () => {
  it('reports a fresh lock held by another device, and allows read-only opening', async () => {
    const dir = await createdCompany();
    const a = newSession().session;
    await a.open(asDir(dir), 'pw', { device: 'Office PC' });

    const b = newSession().session;
    const outcome = await b.open(asDir(dir), 'pw', { device: 'Laptop' });
    expect(outcome).toMatchObject({ kind: 'locked', stale: false, lock: { device: 'Office PC' } });
    // Even "take over" never takes a fresh lock
    expect((await b.open(asDir(dir), 'pw', { device: 'Laptop', mode: 'takeOver' })).kind).toBe(
      'locked',
    );

    const ro = await b.open(asDir(dir), 'pw', { device: 'Laptop', mode: 'readOnly' });
    expect(ro).toMatchObject({ kind: 'opened', status: { readOnly: true, dirty: false } });
    expect(() => b.updateDetails({ city: 'x' })).toThrow(
      expect.objectContaining({ name: 'ReadOnlyError' }),
    );
    await b.close();
    // Closing the read-only copy leaves A's lock alone
    expect(JSON.parse(dir.text(LOCK_FILE)).device).toBe('Office PC');
  });

  it('lets the owner take over a stale lock', async () => {
    const dir = await createdCompany();
    await writeLock(asDir(dir), {
      sessionId: 'crashed',
      device: 'Old laptop',
      user: 'Pat Owner',
      openedAt: '2026-10-01T00:00:00Z',
      heartbeatAt: new Date(new Date(2026, 9, 26, 9).getTime() - STALE_AFTER_MS - 1).toISOString(),
    });
    const { session } = newSession();
    expect(await session.open(asDir(dir), 'pw', { device: 'PC' })).toMatchObject({
      kind: 'locked',
      stale: true,
    });
    expect((await session.open(asDir(dir), 'pw', { device: 'PC', mode: 'takeOver' })).kind).toBe(
      'opened',
    );
    expect(JSON.parse(dir.text(LOCK_FILE)).device).toBe('PC');
  });

  it('stops saving when another device takes the company over (heartbeat)', async () => {
    const dir = await createdCompany();
    const { session } = newSession({ heartbeatMs: 10, saveDelayMs: 10_000 });
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    await writeLock(asDir(dir), {
      sessionId: 'someone-else',
      device: 'Laptop',
      user: 'Pat Owner',
      openedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    await wait(40);
    expect(session.status()).toMatchObject({
      readOnly: true,
      error: { name: 'CompanyLockedError' },
    });
    await expect(session.save()).rejects.toMatchObject({ name: 'CompanyLockedError' });
    await session.discard();
  });

  it('keeps work as a copy in another folder when the file changed on disk (DF-3)', async () => {
    const dir = await createdCompany();
    const { session } = newSession({ saveDelayMs: 10_000 });
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    dir.touchExternally(COMPANY_FILE, new Uint8Array([1, 2, 3]));
    session.updateDetails({ city: 'Mine' });
    await expect(session.save()).rejects.toMatchObject({ name: 'FileChangedOnDiskError' });
    expect(session.status().error?.name).toBe('FileChangedOnDiskError');
    expect(dir.files.get(COMPANY_FILE)!.data).toEqual(new Uint8Array([1, 2, 3]));

    const copy = new FakeDir('Acme copy');
    const status = await session.saveAs(asDir(copy));
    expect(status).toMatchObject({ error: null, dirty: false });
    expect(copy.files.has(COMPANY_FILE)).toBe(true);
    expect(dir.files.has(LOCK_FILE)).toBe(false);
    expect(copy.files.has(LOCK_FILE)).toBe(true);
    await session.close();

    const check = newSession().session;
    await check.open(asDir(copy), 'pw', { device: 'PC' });
    expect(check.details().city).toBe('Mine');
  });

  it('says so when the folder permission is withdrawn, and saves once it is back (DF-2)', async () => {
    const dir = await createdCompany();
    const { session } = newSession({ saveDelayMs: 10_000 });
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    const before = dir.files.get(COMPANY_FILE)!.data;
    expect(session.folder()).toBe(asDir(dir));

    dir.denyAccess = true;
    session.updateDetails({ city: 'Kept' });
    await expect(session.save()).rejects.toMatchObject({ name: 'FolderAccessError' });
    expect(session.status()).toMatchObject({
      dirty: true,
      error: { name: 'FolderAccessError', message: expect.stringContaining('“Acme LLC”') },
    });
    // Still no access: the error stays and nothing is written
    await session.folderAccessRegained();
    expect(session.status()).toMatchObject({ dirty: true, error: { name: 'FolderAccessError' } });
    expect(dir.files.get(COMPANY_FILE)!.data).toBe(before);

    dir.denyAccess = false;
    await session.folderAccessRegained();
    expect(session.status()).toMatchObject({ dirty: false, error: null });
    await session.close();

    const check = newSession().session;
    await check.open(asDir(dir), 'pw', { device: 'PC' });
    expect(check.details().city).toBe('Kept');
  });

  it('clears a lost-permission error from the heartbeat once access is back', async () => {
    const dir = await createdCompany();
    const { session } = newSession({ heartbeatMs: 10, saveDelayMs: 10_000 });
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    dir.denyAccess = true;
    await wait(40);
    expect(session.status().error?.name).toBe('FolderAccessError');
    dir.denyAccess = false;
    await wait(40);
    expect(session.status().error).toBeNull();
    await session.close();
  });

  it('refuses to open a company that another tab of this browser holds (Web Locks)', async () => {
    const held = new Set<string>();
    const locks = {
      request: async (name: string, _opts: unknown, cb: (lock: unknown) => unknown) => {
        if (held.has(name)) return cb(null);
        held.add(name);
        await cb({ name });
        held.delete(name);
      },
    } as unknown as LockManager;
    const dir = await createdCompany();
    const a = newSession({ locks }).session;
    await a.open(asDir(dir), 'pw', { device: 'PC' });
    const companyId = a.status().companyId!;
    expect(held.has(`kmezbooks-company-${companyId}`)).toBe(true);
    await a.close();
    expect(held.size).toBe(0);

    // Another tab holds the company but its lock file isn't there (yet): the tab lock still stops us
    held.add(`kmezbooks-company-${companyId}`);
    const b = newSession({ locks }).session;
    await expect(b.open(asDir(dir), 'pw', { device: 'PC' })).rejects.toMatchObject({
      name: 'OpenInAnotherTabError',
    });
    expect(b.status().open).toBe(false);
  });
});

describe('schema upgrade (DF-11)', () => {
  async function oldCompanyFile(userVersion?: number) {
    const sqlite3 = await loadSqlite();
    const db = openEmptyDatabase(sqlite3);
    migrate(db, MIGRATIONS.slice(0, 1));
    db.exec(`INSERT INTO company (id, legal_name) VALUES ('old-co', 'Old Co')`);
    if (userVersion) db.exec(`PRAGMA user_version = ${userVersion}`);
    const key = await createCompanyKey('pw', FAST);
    const dir = new FakeDir();
    const handle = await dir.getFileHandle(COMPANY_FILE, { create: true });
    const w = await handle.createWritable();
    await w.write(await encryptDatabase(key, serializeDatabase(sqlite3, db)));
    await w.close();
    return dir;
  }

  it('backs up the untouched file, upgrades, adds an owner and logs it', async () => {
    const dir = await oldCompanyFile();
    const original = dir.files.get(COMPANY_FILE)!.data.slice();
    const { session } = newSession();
    const outcome = await session.open(asDir(dir), 'pw', { device: 'PC' });
    expect(outcome).toMatchObject({ kind: 'opened', upgradedFrom: 1 });
    const backupDir = await dir.getDirectoryHandle(BACKUP_DIR);
    const [backup] = await listBackups(asDir(backupDir));
    expect(backup!.label).toBe('before-upgrade-v1');
    expect(backupDir.files.get(backup!.name)!.data).toEqual(original);
    expect(session.audit().map((e) => e.action)).toEqual(
      expect.arrayContaining(['unlock', 'schema_upgrade']),
    );
    expect(session.audit()[0]!.user).toBe('Owner');
  });

  it('refuses a company from a newer app version, writing nothing', async () => {
    const dir = await oldCompanyFile(999);
    const { session } = newSession();
    await expect(session.open(asDir(dir), 'pw', { device: 'PC' })).rejects.toMatchObject({
      name: 'NewerSchemaError',
    });
    expect(dir.dirs.get(BACKUP_DIR)?.files.size ?? 0).toBe(0);
    expect(session.status().open).toBe(false);
  });
});

describe('backups and restore (DF-9, DF-10)', () => {
  it('restores an earlier backup, after backing up the current file', async () => {
    const dir = new FakeDir();
    const { session, advance } = newSession();
    await session.create(asDir(dir), ACME, 'pw', 'PC');
    const [first] = await session.listBackups();
    advance(5 * 60 * 60_000);
    session.updateDetails({ legalName: 'Acme Renamed LLC' });
    await session.save();

    expect(await session.previewBackup(first!.name, 'pw')).toMatchObject({ legalName: 'Acme LLC' });
    await expect(session.previewBackup(first!.name, 'nope')).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });

    const status = await session.restoreBackup(first!.name, 'pw');
    expect(status).toMatchObject({ legalName: 'Acme LLC', dirty: false, open: true });
    expect(
      session.audit().some((e) => e.action === 'restore' && e.note === `from ${first!.name}`),
    ).toBe(true);
    expect(await backups(dir)).toContain('before-restore');
  });

  it('reports one status for a restore, never a closed company in between', async () => {
    const dir = new FakeDir();
    const seen: boolean[] = [];
    const session = new CompanySession({
      iterations: FAST,
      heartbeatMs: 0,
      saveDelayMs: 5,
      onStatus: (s) => seen.push(s.open),
    });
    await session.create(asDir(dir), ACME, 'pw', 'PC');
    const [first] = await session.listBackups();
    seen.length = 0;
    await session.restoreBackup(first!.name, 'pw');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('refuses to restore over a file another device changed, keeping both', async () => {
    const dir = new FakeDir();
    const { session } = newSession({ saveDelayMs: 10_000 });
    await session.create(asDir(dir), ACME, 'pw', 'PC');
    const [first] = await session.listBackups();
    session.updateDetails({ city: 'Unsaved here' });
    dir.touchExternally(COMPANY_FILE, new Uint8Array([7, 7, 7]));
    await expect(session.restoreBackup(first!.name, 'pw')).rejects.toMatchObject({
      name: 'FileChangedOnDiskError',
    });
    expect(dir.files.get(COMPANY_FILE)!.data).toEqual(new Uint8Array([7, 7, 7]));
    expect(session.details().city).toBe('Unsaved here');
  });

  it("refuses to restore another company's backup over this one", async () => {
    const other = new FakeDir();
    const o = newSession().session;
    await o.create(asDir(other), { ...ACME, legalName: 'Other LLC' }, 'pw', 'PC');
    await o.close();
    const otherBackup = [...(await other.getDirectoryHandle(BACKUP_DIR)).files.entries()][0]!;

    const dir = new FakeDir();
    const { session } = newSession();
    await session.create(asDir(dir), ACME, 'pw', 'PC');
    (await dir.getDirectoryHandle(BACKUP_DIR)).files.set(otherBackup[0], otherBackup[1]);
    await expect(session.restoreBackup(otherBackup[0], 'pw')).rejects.toMatchObject({
      name: 'WrongCompanyError',
    });
    expect(session.details().legalName).toBe('Acme LLC');
  });

  it('restores a backup file into an empty folder when the company folder is lost', async () => {
    const dir = await createdCompany();
    const backupDir = await dir.getDirectoryHandle(BACKUP_DIR);
    const [name] = [...backupDir.files.keys()];
    const fileHandle = await backupDir.getFileHandle(name!);

    const target = new FakeDir('Restored');
    const { session } = newSession();
    expect(
      await session.previewBackupFile(fileHandle as unknown as FileSystemFileHandle, 'pw'),
    ).toMatchObject({ legalName: 'Acme LLC' });
    const status = await session.restoreInto(
      fileHandle as unknown as FileSystemFileHandle,
      'pw',
      asDir(target),
      'PC',
    );
    expect(status).toMatchObject({ open: true, legalName: 'Acme LLC' });
    expect(target.files.has(COMPANY_FILE)).toBe(true);
    expect(session.audit().some((e) => e.action === 'restore')).toBe(true);
    // Never over an existing company
    await session.close();
    await expect(
      newSession().session.restoreInto(
        fileHandle as unknown as FileSystemFileHandle,
        'pw',
        asDir(target),
        'PC',
      ),
    ).rejects.toMatchObject({ name: 'CompanyExistsError' });
  });
});

describe('passphrase change (US-1)', () => {
  it('saves under the new passphrase at once; old backups keep the old one', async () => {
    const dir = await createdCompany('old pass');
    const { session } = newSession();
    await session.open(asDir(dir), 'old pass', { device: 'PC' });
    await session.changePassphrase('old pass', 'new pass');
    const [backup] = await session.listBackups();
    await session.close();

    const check = newSession().session;
    await expect(check.open(asDir(dir), 'old pass', { device: 'PC' })).rejects.toMatchObject({
      name: 'WrongPassphraseError',
    });
    expect((await check.open(asDir(dir), 'new pass', { device: 'PC' })).kind).toBe('opened');
    expect(check.audit().some((e) => e.action === 'passphrase_change')).toBe(true);
    expect(await check.previewBackup(backup!.name, 'old pass')).toMatchObject({
      legalName: 'Acme LLC',
    });
  });
});
