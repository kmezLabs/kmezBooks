import { describe, expect, it } from 'vitest';
import { migrate, parseMigrations, schemaVersion } from './migrations';
import { MIGRATIONS } from './schema';
import { loadSqlite, openEmptyDatabase } from './sqlite';

const newDb = async () => openEmptyDatabase(await loadSqlite());

describe('parseMigrations', () => {
  it('orders files by number', () => {
    const list = parseMigrations({
      '/db/migrations/0002_b.sql': 'B',
      '/db/migrations/0001_a.sql': 'A',
    });
    expect(list.map((m) => m.name)).toEqual(['0001_a', '0002_b']);
  });

  it('rejects gaps, duplicates and bad names', () => {
    expect(() => parseMigrations({ '0001_a.sql': '', '0003_c.sql': '' })).toThrow(/without gaps/);
    expect(() => parseMigrations({ 'x/0001_a.sql': '', 'y/0001_b.sql': '' })).toThrow(
      /without gaps/,
    );
    expect(() => parseMigrations({ 'init.sql': '' })).toThrow(/0001_name\.sql/);
  });

  it('ships a valid sequence', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
  });
});

describe('migrate (DF-11)', () => {
  const twoSteps = parseMigrations({
    '0001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;',
    '0002_b.sql': 'CREATE TABLE b (y INTEGER) STRICT;',
  });

  it('applies pending migrations and sets user_version', async () => {
    const db = await newDb();
    expect(migrate(db, twoSteps)).toEqual({ from: 0, to: 2 });
    expect(migrate(db, twoSteps)).toEqual({ from: 2, to: 2 });
  });

  it('upgrades an older database from where it left off', async () => {
    const db = await newDb();
    migrate(db, twoSteps.slice(0, 1));
    expect(migrate(db, twoSteps)).toEqual({ from: 1, to: 2 });
  });

  it('rolls a failed migration back completely, including user_version', async () => {
    const db = await newDb();
    const broken = parseMigrations({
      '0001_a.sql': 'CREATE TABLE a (x INTEGER) STRICT;',
      '0002_b.sql': 'CREATE TABLE b (y INTEGER) STRICT; INSERT INTO nowhere VALUES (1);',
    });
    expect(() => migrate(db, broken)).toThrow(/Migration 0002_b failed/);
    expect(schemaVersion(db)).toBe(1);
    expect(db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE name = 'b'`)).toBe(0);
  });

  it('refuses a database from a newer app version', async () => {
    const db = await newDb();
    migrate(db, twoSteps);
    expect(() => migrate(db, twoSteps.slice(0, 1))).toThrow(
      expect.objectContaining({ name: 'NewerSchemaError' }),
    );
  });
});
