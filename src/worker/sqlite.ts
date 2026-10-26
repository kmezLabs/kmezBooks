// SQLite in memory: the open company's database lives here between open and
// save (DF-2). Runs in the browser worker and, for tests, in Node.

import init, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { DamagedFileError } from './errors';

export type { Database, Sqlite3Static };

let loading: Promise<Sqlite3Static> | undefined;

export function loadSqlite(): Promise<Sqlite3Static> {
  return (loading ??= init());
}

function configure(db: Database): Database {
  // Per-connection settings; must be reapplied after every open or deserialize
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function openEmptyDatabase(sqlite3: Sqlite3Static): Database {
  return configure(new sqlite3.oo1.DB(':memory:', 'c'));
}

/** Load a serialized database into memory. Throws DamagedFileError if it isn't a sound database. */
export function deserializeDatabase(sqlite3: Sqlite3Static, bytes: Uint8Array): Database {
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    // SQLite takes ownership of the buffer (FREEONCLOSE), including on failure
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    const { SQLITE_DESERIALIZE_FREEONCLOSE, SQLITE_DESERIALIZE_RESIZEABLE } = sqlite3.capi;
    const rc = sqlite3.capi.sqlite3_deserialize(
      db,
      'main',
      pointer,
      bytes.byteLength,
      bytes.byteLength,
      SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE,
    );
    db.checkRc(rc);
    const check = db.selectValue('PRAGMA quick_check');
    if (check !== 'ok') throw new Error(String(check));
  } catch (e) {
    db.close();
    throw new DamagedFileError(
      `The company database is damaged (${e instanceof Error ? e.message : String(e)}). Restore it from a backup.`,
    );
  }
  return configure(db);
}

export function serializeDatabase(sqlite3: Sqlite3Static, db: Database): Uint8Array<ArrayBuffer> {
  return sqlite3.capi.sqlite3_js_db_export(db);
}
