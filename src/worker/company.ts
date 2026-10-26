// The open company: its in-memory database, unlocked key and folder (DF-1, DF-2).
// Open = read file → unlock key → decrypt → deserialize → migrate.
// Save = serialize → encrypt → verify → atomic write with the on-disk check.

import { COMPANY_FILE, readCompanyFile, writeCompanyFile, type FileStamp } from './companyFolder';
import {
  createCompanyKey,
  decryptDatabase,
  encryptDatabase,
  readHeader,
  unlockCompanyKey,
  type CompanyKey,
} from './ebkFormat';
import { AppError, CompanyExistsError } from './errors';
import { migrate, schemaVersion } from './migrations';
import { MIGRATIONS } from './schema';
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

export class OpenCompany {
  private constructor(
    readonly sqlite3: Sqlite3Static,
    readonly db: Database,
    private key: CompanyKey,
    readonly dir: FileSystemDirectoryHandle,
    private stamp: FileStamp | null,
  ) {}

  /** Create a new company in an empty (or non-company) folder and save it once (CO-1). */
  static async create(
    dir: FileSystemDirectoryHandle,
    passphrase: string,
    legalName: string,
    iterations?: number,
  ): Promise<{ company: OpenCompany; timings: Timings }> {
    const timings: Timings = {};
    try {
      await dir.getFileHandle(COMPANY_FILE);
      throw new CompanyExistsError(`This folder already holds a company (${COMPANY_FILE}).`);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
    const sqlite3 = await timed(timings, 'loadSqlite', loadSqlite);
    const key = await timed(timings, 'deriveKey', () => createCompanyKey(passphrase, iterations));
    const db = openEmptyDatabase(sqlite3);
    await timed(timings, 'migrate', () => migrate(db, MIGRATIONS));
    db.exec({
      sql: 'INSERT INTO company (id, legal_name) VALUES (?, ?)',
      bind: [crypto.randomUUID(), legalName],
    });
    const company = new OpenCompany(sqlite3, db, key, dir, null);
    Object.assign(timings, (await company.save()).timings);
    return { company, timings };
  }

  /** Open and unlock an existing company folder (DF-1, US-1). */
  static async open(
    dir: FileSystemDirectoryHandle,
    passphrase: string,
  ): Promise<{ company: OpenCompany; timings: Timings }> {
    const timings: Timings = {};
    const sqlite3 = await timed(timings, 'loadSqlite', loadSqlite);
    const { bytes, stamp } = await timed(timings, 'read', () => readCompanyFile(dir));
    const key = await timed(timings, 'deriveKey', () =>
      unlockCompanyKey(readHeader(bytes), passphrase),
    );
    const plain = await timed(timings, 'decrypt', () => decryptDatabase(key, bytes));
    const db = await timed(timings, 'deserialize', () => deserializeDatabase(sqlite3, plain));
    // M2: back up before upgrading the schema (DF-11). Upgrades are saved on the next save.
    await timed(timings, 'migrate', () => migrate(db, MIGRATIONS));
    return { company: new OpenCompany(sqlite3, db, key, dir, stamp), timings };
  }

  info(): CompanyInfo {
    const row = this.db.selectObjects('SELECT id, legal_name FROM company')[0];
    return {
      id: String(row?.id),
      legalName: String(row?.legal_name),
      schemaVersion: schemaVersion(this.db),
      dbBytes:
        Number(this.db.selectValue('PRAGMA page_count')) *
        Number(this.db.selectValue('PRAGMA page_size')),
    };
  }

  /** Save the whole database atomically (DF-2), refusing if the file changed on disk (DF-3). */
  async save(): Promise<SaveResult> {
    const timings: Timings = {};
    const plain = await timed(timings, 'serialize', () => serializeDatabase(this.sqlite3, this.db));
    const file = await timed(timings, 'encrypt', () => encryptDatabase(this.key, plain));
    // Never write a file we can't read back (CLAUDE.md rule 2)
    await timed(timings, 'verify', async () => {
      const roundTrip = await decryptDatabase(this.key, file);
      if (!sameBytes(roundTrip, plain)) {
        throw new AppError('Save aborted: the encrypted file did not read back correctly.');
      }
    });
    this.stamp = await timed(timings, 'write', () => writeCompanyFile(this.dir, file, this.stamp));
    return { fileBytes: file.byteLength, dbBytes: plain.byteLength, timings };
  }

  close(): void {
    this.db.close();
  }
}
