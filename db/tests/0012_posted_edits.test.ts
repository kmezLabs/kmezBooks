import { beforeEach, describe, expect, it } from 'vitest';
import { getEntry } from '../../src/ledger/entries';
import {
  changeEntry,
  correctEntry,
  deleteEntry,
  postEntry,
  type EntryChange,
} from '../../src/ledger/postEntry';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post, startImportRun } from './ledgerTestDb';

let db: Database;
const allow = (on = true) => db.exec(`UPDATE company SET posted_edits = ${on ? 1 : 0}`);
const lines = (debit: string, credit: string, cents: number) => [
  { accountId: accountId(db, debit), debit: cents, credit: 0 },
  { accountId: accountId(db, credit), debit: 0, credit: cents },
];
const change = (date: string, cents: number, extra: Partial<EntryChange> = {}): EntryChange => ({
  date,
  name: 'Power Co',
  lines: lines('Utilities', 'Checking', cents),
  ...extra,
});
const events = (id: number) =>
  db
    .selectObjects(
      `SELECT action, before FROM audit_event WHERE entity = 'journal_entry' AND entity_id = ? ORDER BY id`,
      [String(id)],
    )
    .map((r) => String(r.action));

beforeEach(async () => {
  db = await newLedgerDb();
});

describe('changing posted entries (GL-6)', () => {
  it('is refused unless the company allows it', () => {
    const id = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    expect(() => changeEntry(db, id, change('2026-01-10', 50_00))).toThrow(
      'Posted entries cannot be changed in this company',
    );
    expect(() => deleteEntry(db, id)).toThrow('Posted entries cannot be changed in this company');
    expect(getEntry(db, id)!.amount).toBe(45_00);
  });

  it('rewrites an entry in place and posts it again, keeping what it was in the audit log', () => {
    allow();
    const id = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00, { memo: 'January' });
    changeEntry(db, id, change('2026-01-12', 50_00, { memo: 'January power', ref: 'B-7' }));
    expect(getEntry(db, id)).toMatchObject({
      status: 'posted',
      date: '2026-01-12',
      ref: 'B-7',
      name: 'Power Co',
      memo: 'January power',
      amount: 50_00,
      sourceType: 'journal',
    });
    expect(events(id)).toEqual(['post', 'unpost', 'post']);
    const before = JSON.parse(
      String(
        db.selectValue(`SELECT before FROM audit_event WHERE action = 'unpost' AND entity_id = ?`, [
          String(id),
        ]),
      ),
    );
    expect(before).toMatchObject({
      date: '2026-01-10',
      memo: 'January',
      lines: [{ debit: 45_00 }, { credit: 45_00 }],
    });
  });

  it('checks a changed entry like a new one, and leaves it alone when it fails', () => {
    allow();
    const id = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    const unbalanced = {
      ...change('2026-01-10', 50_00),
      lines: [
        ...lines('Utilities', 'Checking', 50_00).slice(0, 1),
        { accountId: accountId(db, 'Checking'), debit: 0, credit: 49_00 },
      ],
    };
    expect(() => changeEntry(db, id, unbalanced)).toThrow('Debits and credits must be equal');
    expect(getEntry(db, id)).toMatchObject({ status: 'posted', amount: 45_00 });
  });

  it('respects the closing date on the way out and on the way back (PC-1)', () => {
    allow();
    const closed = post(db, '2025-12-20', 'Utilities', 'Checking', 45_00);
    const open = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    db.exec(`UPDATE company SET closing_date = '2025-12-31'`);
    expect(() => changeEntry(db, closed, change('2026-01-02', 45_00))).toThrow(
      expect.objectContaining({ name: 'ClosedPeriodError' }),
    );
    expect(() => changeEntry(db, open, change('2025-12-30', 45_00))).toThrow(
      expect.objectContaining({ name: 'ClosedPeriodError' }),
    );
    expect(() => deleteEntry(db, closed)).toThrow(
      expect.objectContaining({ name: 'ClosedPeriodError' }),
    );
    changeEntry(db, closed, change('2025-12-21', 46_00), { closingOverride: true });
    expect(
      db.selectValue(`SELECT count(*) FROM audit_event WHERE action = 'closed_period_override'`),
    ).toBe(2);
  });

  it('keeps entries cleared by a finished reconciliation; one in progress lets go (BK-8)', () => {
    allow();
    const checking = accountId(db, 'Checking');
    const done = post(db, '2026-01-05', 'Checking', 'Services', 100_00);
    const pending = post(db, '2026-02-05', 'Checking', 'Services', 50_00);
    const rec = (id: string, date: string, ending: number) =>
      db.exec({
        sql: `INSERT INTO reconciliation (id, company_id, account_id, statement_date, ending_balance) VALUES (?, (SELECT id FROM company), ?, ?, ?)`,
        bind: [id, checking, date, ending],
      });
    const clear = (r: string, entry: number) =>
      db.exec({
        sql: `INSERT INTO reconciled_line (line_id, company_id, reconciliation_id) SELECT id, company_id, ? FROM journal_line WHERE entry_id = ? AND account_id = ?`,
        bind: [r, entry, checking],
      });
    rec('jan', '2026-01-31', 100_00);
    clear('jan', done);
    db.exec(
      `UPDATE reconciliation SET status = 'done', beginning_balance = 0, finished_at = 'x' WHERE id = 'jan'`,
    );
    rec('feb', '2026-02-28', 150_00);
    clear('feb', pending);
    expect(() =>
      changeEntry(db, done, { date: '2026-01-05', lines: lines('Checking', 'Services', 90_00) }),
    ).toThrow('This entry was reconciled');
    expect(() => deleteEntry(db, done)).toThrow('This entry was reconciled');
    changeEntry(db, pending, { date: '2026-02-05', lines: lines('Checking', 'Services', 60_00) });
    expect(
      db.selectValue(`SELECT count(*) FROM reconciled_line WHERE reconciliation_id = 'feb'`),
    ).toBe(0);
  });

  it('keeps bank transactions linked while the entry still fits them (BK-4)', () => {
    allow();
    const checking = accountId(db, 'Checking');
    db.exec({
      sql: `INSERT INTO bank_import (id, company_id, account_id, file_name, added, duplicates) VALUES ('i', (SELECT id FROM company), ?, 'f', 1, 0)`,
      bind: [checking],
    });
    const txn = Number(
      db.selectValue(
        `INSERT INTO bank_txn (company_id, account_id, import_id, fitid, date, amount) VALUES ((SELECT id FROM company), ?, 'i', 'F', '2026-01-10', -4500) RETURNING id`,
        [checking],
      ),
    );
    const id = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    db.exec({
      sql: `UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE id = ?`,
      bind: [id, txn],
    });
    const status = () =>
      db.selectObjects('SELECT status, entry_id FROM bank_txn WHERE id = ?', [txn])[0];

    changeEntry(
      db,
      id,
      change('2026-01-11', 45_00, {
        lines: lines('Office Supplies and Software', 'Checking', 45_00),
      }),
    );
    expect(status()).toEqual({ status: 'matched', entry_id: id });
    changeEntry(db, id, change('2026-01-11', 40_00));
    expect(status()).toEqual({ status: 'new', entry_id: null });

    db.exec({
      sql: `UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE id = ?`,
      bind: [post(db, '2026-01-10', 'Utilities', 'Checking', 45_00), txn],
    });
    const linked = Number(status()!.entry_id);
    allow(false);
    // With changes not allowed, a correction is a void and a new entry; the link follows it
    const corrected = correctEntry(db, linked, change('2026-01-10', 45_00, { memo: 'fixed' }));
    expect(getEntry(db, linked)!.status).toBe('void');
    expect(status()).toEqual({ status: 'matched', entry_id: corrected });
    allow();
    deleteEntry(db, corrected);
    expect(status()).toEqual({ status: 'new', entry_id: null });
  });

  it('deletes an entry with its attachments, logged; QuickBooks history can be corrected but not deleted', () => {
    allow();
    const id = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    db.exec({
      sql: `INSERT INTO attachment (id, company_id, entity, entity_id, file_name, mime_type, size, sha256)
            VALUES ('a1', (SELECT id FROM company), 'journal_entry', ?, 'r.pdf', 'application/pdf', 1, ?)`,
      bind: [String(id), 'a'.repeat(64)],
    });
    deleteEntry(db, id);
    expect(getEntry(db, id)).toBeNull();
    expect(db.selectValue('SELECT count(*) FROM attachment')).toBe(0);
    expect(events(id)).toEqual(['post', 'unpost', 'delete']);

    const run = startImportRun(db);
    const migrated = postEntry(db, {
      date: '2025-06-01',
      sourceType: 'qbo_migration',
      sourceId: run,
      lines: lines('Utilities', 'Checking', 10_00),
    });
    db.exec({
      sql: `INSERT INTO qbo_entry (entry_id, company_id, run_id, txn_type, source) VALUES (?, (SELECT id FROM company), ?, 'Check', 'f:1')`,
      bind: [migrated, run],
    });
    db.exec(`UPDATE qbo_import_run SET status = 'done', finished_at = 'x'`);
    changeEntry(db, migrated, change('2025-06-01', 12_00));
    expect(getEntry(db, migrated)).toMatchObject({
      status: 'posted',
      amount: 12_00,
      sourceType: 'qbo_migration',
    });
    expect(() => deleteEntry(db, migrated)).toThrow('QuickBooks history cannot be deleted');
    // New history still needs a running import
    expect(() =>
      postEntry(db, {
        date: '2025-06-02',
        sourceType: 'qbo_migration',
        sourceId: run,
        lines: lines('Utilities', 'Checking', 1_00),
      }),
    ).toThrow('QuickBooks history can only be posted by a running import');
  });
});
