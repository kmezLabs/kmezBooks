import { beforeEach, describe, expect, it } from 'vitest';
import { postEntry, voidEntry } from '../../src/ledger/postEntry';
import type { Database } from '../../src/worker/sqlite';
import { newLedgerDb, post, simple, startImportRun } from './ledgerTestDb';

const raise =
  (db: Database, sql: string, bind: (string | number | null)[] = []) =>
  () =>
    db.exec({ sql, bind });

const migrated = (db: Database, run: string | null) =>
  postEntry(
    db,
    simple(db, '2016-01-10', 'Meals', 'Checking', 10_00, {
      sourceType: 'qbo_migration',
      sourceId: run,
    }),
  );

describe('QuickBooks import runs (MG-6)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
  });

  it('posts migrated history only during a running import', () => {
    expect(() => migrated(db, null)).toThrow(/running import/);
    expect(() => migrated(db, 'no-such-run')).toThrow(/running import/);
    const run = startImportRun(db);
    expect(() => migrated(db, run)).not.toThrow();
    db.exec(`UPDATE qbo_import_run SET status = 'done', finished_at = 'now'`);
    expect(() => migrated(db, run)).toThrow(/running import/);
  });

  it('starts a run only in a company without transactions', () => {
    post(db, '2026-01-05', 'Meals', 'Checking', 10_00);
    expect(() => startImportRun(db)).toThrow(/new company/);
  });

  it('keeps finished runs as they are', () => {
    const run = startImportRun(db);
    db.exec(`UPDATE qbo_import_run SET status = 'done', finished_at = 'now', summary = '{}'`);
    expect(raise(db, `UPDATE qbo_import_run SET summary = '{"x":1}'`)).toThrow(
      /finished import run/,
    );
    expect(raise(db, `UPDATE qbo_import_run SET status = 'running', finished_at = NULL`)).toThrow(
      /finished import run/,
    );
    expect(raise(db, 'DELETE FROM qbo_import_run WHERE id = ?', [run])).toThrow(/kept/);
    expect(
      raise(
        db,
        `INSERT INTO qbo_import_run (id, company_id, status, finished_at) VALUES ('r2', (SELECT id FROM company), 'done', 'now')`,
      ),
    ).toThrow(/starts as running/);
  });

  it('records where each migrated entry came from, unchangeably', () => {
    const run = startImportRun(db);
    const id = migrated(db, run);
    const insert = (entryId: number, runId: string) =>
      raise(
        db,
        `INSERT INTO qbo_entry (entry_id, company_id, run_id, txn_type, source) VALUES (?, (SELECT id FROM company), ?, 'Check', 'J row 6')`,
        [entryId, runId],
      );
    expect(insert(id, 'no-such-run')).toThrow(/running import/);
    expect(insert(id, run)).not.toThrow();
    expect(raise(db, `UPDATE qbo_entry SET txn_type = 'Deposit'`)).toThrow(/cannot be changed/);
    expect(raise(db, `DELETE FROM qbo_entry`)).toThrow(/cannot be changed/);
  });

  it('audits migrated postings through the run, and still audits voiding them (US-5)', () => {
    const run = startImportRun(db);
    const id = migrated(db, run);
    const manual = post(db, '2026-01-05', 'Meals', 'Checking', 10_00);
    const events = () =>
      db
        .selectArrays(
          `SELECT action, entity_id FROM audit_event WHERE entity = 'journal_entry' ORDER BY id`,
        )
        .map((r) => r.join(' '));
    expect(events()).toEqual([`post ${manual}`]);
    voidEntry(db, id, 'duplicate');
    expect(events()).toEqual([`post ${manual}`, `void ${id}`]);
  });
});

describe('names on entries (MG-3)', () => {
  it('stores names, and a posted entry keeps its name', async () => {
    const db = await newLedgerDb();
    const id = post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: 'Diner' });
    expect(db.selectValue('SELECT name FROM journal_entry WHERE id = ?', [id])).toBe('Diner');
    expect(raise(db, `UPDATE journal_entry SET name = 'Other' WHERE id = ?`, [id])).toThrow(/GL-6/);
  });
});

describe('customers and vendors (MG-1)', () => {
  it('keeps names unique within each list, ignoring case', async () => {
    const db = await newLedgerDb();
    const add = (table: string, name: string) =>
      raise(
        db,
        `INSERT INTO ${table} (id, company_id, name) VALUES (?, (SELECT id FROM company), ?)`,
        [crypto.randomUUID(), name],
      );
    expect(add('customer', 'Acme')).not.toThrow();
    expect(add('customer', 'ACME')).toThrow(/UNIQUE/);
    expect(add('vendor', 'Acme')).not.toThrow();
    expect(add('vendor', ' ')).toThrow(/CHECK/);
  });
});
