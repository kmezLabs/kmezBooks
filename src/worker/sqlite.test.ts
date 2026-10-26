import { describe, expect, it } from 'vitest';
import { deserializeDatabase, loadSqlite, openEmptyDatabase, serializeDatabase } from './sqlite';

describe('in-memory database serialize/deserialize (DF-2)', () => {
  it('round-trips schema and rows', async () => {
    const sqlite3 = await loadSqlite();
    const db = openEmptyDatabase(sqlite3);
    db.exec(`CREATE TABLE t (cents INTEGER NOT NULL) STRICT; INSERT INTO t VALUES (12345), (-1);
             PRAGMA user_version = 7;`);
    const bytes = serializeDatabase(sqlite3, db);
    db.close();

    const copy = deserializeDatabase(sqlite3, bytes);
    expect(copy.selectValue('SELECT sum(cents) FROM t')).toBe(12344);
    expect(copy.selectValue('PRAGMA user_version')).toBe(7);
    expect(copy.selectValue('PRAGMA foreign_keys')).toBe(1);
    // Still writable after loading
    copy.exec('INSERT INTO t VALUES (1)');
    expect(copy.selectValue('SELECT count(*) FROM t')).toBe(3);
  });

  it('rejects bytes that are not a database', async () => {
    const sqlite3 = await loadSqlite();
    expect(() => deserializeDatabase(sqlite3, new TextEncoder().encode('not a db'.repeat(100)))).toThrow(
      expect.objectContaining({ name: 'DamagedFileError' }),
    );
  });

  it('rejects a truncated database', async () => {
    const sqlite3 = await loadSqlite();
    const db = openEmptyDatabase(sqlite3);
    db.exec(`CREATE TABLE t (x TEXT) STRICT;`);
    for (let i = 0; i < 200; i++) db.exec({ sql: 'INSERT INTO t VALUES (?)', bind: ['x'.repeat(500)] });
    const bytes = serializeDatabase(sqlite3, db);
    expect(() => deserializeDatabase(sqlite3, bytes.slice(0, bytes.length / 2))).toThrow(
      expect.objectContaining({ name: 'DamagedFileError' }),
    );
  });
});
