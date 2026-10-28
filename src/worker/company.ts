// The open company: its in-memory database, unlocked key and folder (DF-1, DF-2).
// Open = read file → unlock key → decrypt → deserialize → schema upgrade → session.
// Save = serialize → encrypt → verify → atomic write with the on-disk check.

import { checkBackup, type BackupCheck } from './backupDrill';
import { recordEvent } from './audit';
import {
  initCompany,
  latestActivity,
  readDetails,
  startSession,
  type NewCompany,
} from './companyData';
import { COMPANY_FILE, readCompanyFile, writeCompanyFile, type FileStamp } from './companyFolder';
import {
  changePassphrase,
  createCompanyKey,
  decryptBlob,
  decryptDatabase,
  encryptBlob,
  encryptDatabase,
  readHeader,
  unlockCompanyKey,
  verifyPassphrase,
  type CompanyKey,
} from './ebkFormat';
import { AppError, CompanyExistsError, ReadOnlyError } from './errors';
import { schemaVersion } from './migrations';
import { LATEST_SCHEMA, applySchema } from './schema';
import {
  deserializeDatabase,
  loadSqlite,
  openEmptyDatabase,
  serializeDatabase,
  type Database,
  type Sqlite3Static,
} from './sqlite';

/** Milliseconds per step, for the M1 measurements. */
export type Timings = Record<string, number>;

export interface CompanyInfo {
  id: string;
  legalName: string;
  schemaVersion: number;
  dbBytes: number;
}

export interface SaveResult {
  fileBytes: number;
  dbBytes: number;
  timings: Timings;
  /** The encrypted bytes just written; the worker copies them as a backup when one is due. */
  file: Uint8Array<ArrayBuffer>;
}

export interface OpenOptions {
  readOnly?: boolean;
  /** Who and where, for the unlock entry in the audit log. */
  device?: string;
  /** Called with the untouched file before a schema upgrade, so it can be backed up (DF-11). */
  beforeUpgrade?: (file: Uint8Array<ArrayBuffer>, fromVersion: number) => Promise<void>;
  iterations?: number;
}

export interface BackupPreview {
  companyId: string;
  legalName: string;
  schemaVersion: number;
  latestActivity: string | null;
}

async function timed<T>(timings: Timings, step: string, fn: () => T | Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[step] = Math.round((performance.now() - start) * 10) / 10;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function assertNoCompany(dir: FileSystemDirectoryHandle) {
  try {
    await dir.getFileHandle(COMPANY_FILE);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotFoundError') return;
    throw e;
  }
  throw new CompanyExistsError(`This folder already holds a company (${COMPANY_FILE}).`);
}

/** Decrypt and load a file into memory without touching any folder. */
async function load(
  bytes: Uint8Array<ArrayBuffer>,
  passphrase: string,
  timings: Timings,
): Promise<{ sqlite3: Sqlite3Static; db: Database; key: CompanyKey }> {
  const sqlite3 = await timed(timings, 'loadSqlite', loadSqlite);
  const key = await timed(timings, 'deriveKey', () =>
    unlockCompanyKey(readHeader(bytes), passphrase),
  );
  const plain = await timed(timings, 'decrypt', () => decryptDatabase(key, bytes));
  const db = await timed(timings, 'deserialize', () => deserializeDatabase(sqlite3, plain));
  return { sqlite3, db, key };
}

export class OpenCompany {
  private savedChanges: number;

  private constructor(
    readonly sqlite3: Sqlite3Static,
    readonly db: Database,
    private key: CompanyKey,
    private folder: FileSystemDirectoryHandle,
    private stamp: FileStamp | null,
    readonly readOnly: boolean,
  ) {
    // Opening writes the session and the unlock entry (US-5), so a company
    // starts with unsaved changes; the autosave puts them on disk
    this.savedChanges = -1;
    if (readOnly) db.exec('PRAGMA query_only = ON');
  }

  get dir(): FileSystemDirectoryHandle {
    return this.folder;
  }

  get id(): string {
    return String(this.db.selectValue('SELECT id FROM company'));
  }

  /** Create a new company in a folder without one, and save it once (CO-1). */
  static async create(
    dir: FileSystemDirectoryHandle,
    details: NewCompany,
    passphrase: string,
    iterations?: number,
  ): Promise<{ company: OpenCompany; timings: Timings }> {
    const timings: Timings = {};
    await assertNoCompany(dir);
    const sqlite3 = await timed(timings, 'loadSqlite', loadSqlite);
    const key = await timed(timings, 'deriveKey', () => createCompanyKey(passphrase, iterations));
    const db = openEmptyDatabase(sqlite3);
    await timed(timings, 'migrate', () => applySchema(db));
    initCompany(
      db,
      { companyId: crypto.randomUUID(), ownerId: crypto.randomUUID() },
      details,
      new Date(),
    );
    const company = new OpenCompany(sqlite3, db, key, dir, null, false);
    Object.assign(timings, (await company.save()).timings);
    return { company, timings };
  }

  /** Open and unlock an existing company folder (DF-1, US-1, DF-11). */
  static async open(
    dir: FileSystemDirectoryHandle,
    passphrase: string,
    opts: OpenOptions = {},
  ): Promise<{ company: OpenCompany; timings: Timings; upgradedFrom: number | null }> {
    const timings: Timings = {};
    const { bytes, stamp } = await timed(timings, 'read', () => readCompanyFile(dir));
    const { sqlite3, db, key } = await load(bytes, passphrase, timings);
    try {
      const from = schemaVersion(db);
      // Back up the untouched file before changing its schema (DF-11). A
      // newer file is refused by applySchema, so it is never "upgraded".
      if (from < LATEST_SCHEMA && !opts.readOnly) await opts.beforeUpgrade?.(bytes, from);
      await timed(timings, 'migrate', () => applySchema(db));
      startSession(db, new Date());
      if (!opts.readOnly) {
        if (from < LATEST_SCHEMA)
          recordEvent(db, 'schema_upgrade', `schema ${from} → ${LATEST_SCHEMA}`);
        recordEvent(db, 'unlock', opts.device);
      }
      const company = new OpenCompany(sqlite3, db, key, dir, stamp, opts.readOnly ?? false);
      return { company, timings, upgradedFrom: from < LATEST_SCHEMA ? from : null };
    } catch (e) {
      db.close();
      throw e;
    }
  }

  /**
   * The restore drill (M8): open a backup in memory, never in place, and
   * check it against this company (backupDrill.ts). Nothing is written.
   */
  async drill(
    bytes: Uint8Array<ArrayBuffer>,
    passphrase: string,
    attachmentFound: (id: string) => Promise<boolean>,
  ): Promise<BackupCheck> {
    const { db } = await load(bytes, passphrase, {});
    try {
      return await checkBackup(db, this.db, attachmentFound);
    } finally {
      db.close();
    }
  }

  /** Open a backup in memory just long enough to describe it (DF-10). */
  static async inspect(bytes: Uint8Array<ArrayBuffer>, passphrase: string): Promise<BackupPreview> {
    const { db } = await load(bytes, passphrase, {});
    try {
      const version = schemaVersion(db);
      const row = db.selectObjects('SELECT id, legal_name FROM company')[0];
      const hasAudit =
        db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE name = 'audit_event'`) === 1;
      return {
        companyId: String(row?.id),
        legalName: String(row?.legal_name),
        schemaVersion: version,
        latestActivity: hasAudit ? latestActivity(db) : null,
      };
    } finally {
      db.close();
    }
  }

  info(): CompanyInfo {
    return {
      id: this.id,
      legalName: readDetails(this.db).legalName,
      schemaVersion: schemaVersion(this.db),
      dbBytes:
        Number(this.db.selectValue('PRAGMA page_count')) *
        Number(this.db.selectValue('PRAGMA page_size')),
    };
  }

  private totalChanges(): number {
    return this.db.changes(true);
  }

  /** True when there are changes not yet written to the company file (DF-2). */
  get dirty(): boolean {
    return !this.readOnly && this.totalChanges() !== this.savedChanges;
  }

  /**
   * Run `fn`, which must leave the database exactly as it was (a dry run that
   * rolls back). SQLite counts rolled-back writes as changes; this keeps them
   * from showing as unsaved work when there was none before.
   */
  unchanged<T>(fn: () => T, rolledBack: (result: T) => boolean = () => true): T {
    const wasDirty = this.dirty;
    const result = fn();
    if (!wasDirty && rolledBack(result)) this.savedChanges = this.totalChanges();
    return result;
  }

  /** Save the whole database atomically (DF-2), refusing if the file changed on disk (DF-3). */
  async save(): Promise<SaveResult> {
    if (this.readOnly) throw new ReadOnlyError('This company is open read-only.');
    const timings: Timings = {};
    const changes = this.totalChanges();
    const plain = await timed(timings, 'serialize', () => serializeDatabase(this.sqlite3, this.db));
    const file = await timed(timings, 'encrypt', () => encryptDatabase(this.key, plain));
    // Never write a file we can't read back (CLAUDE.md rule 2)
    await timed(timings, 'verify', async () => {
      const roundTrip = await decryptDatabase(this.key, file);
      if (!sameBytes(roundTrip, plain)) {
        throw new AppError('Save aborted: the encrypted file did not read back correctly.');
      }
    });
    this.stamp = await timed(timings, 'write', () =>
      writeCompanyFile(this.folder, file, this.stamp),
    );
    this.savedChanges = changes;
    return { fileBytes: file.byteLength, dbBytes: plain.byteLength, timings, file };
  }

  /**
   * Save into a different, empty folder and carry on working there (DF-3: when
   * the original changed on disk, the owner keeps their work as a copy).
   */
  async saveAs(dir: FileSystemDirectoryHandle): Promise<SaveResult> {
    await assertNoCompany(dir);
    const previous = { folder: this.folder, stamp: this.stamp };
    this.folder = dir;
    this.stamp = null;
    try {
      return await this.save();
    } catch (e) {
      Object.assign(this, previous);
      throw e;
    }
  }

  /** Re-wrap the data key under a new passphrase (US-1); takes effect on the next save. */
  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    if (this.readOnly) throw new ReadOnlyError('This company is open read-only.');
    this.key = await changePassphrase(this.key, oldPassphrase, newPassphrase);
    recordEvent(this.db, 'passphrase_change');
  }

  /** Re-confirm the passphrase, e.g. for the closed-period override (PC-2). */
  verifyPassphrase(passphrase: string): Promise<boolean> {
    return verifyPassphrase(this.key, passphrase);
  }

  /** Encrypt an attachment with this company's data key (GL-4). */
  encryptBlob(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return encryptBlob(this.key, bytes);
  }

  decryptBlob(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return decryptBlob(this.key, bytes);
  }

  close(): void {
    this.db.close();
  }
}
