import { describe, expect, it } from 'vitest';
import { postEntry } from '../../src/ledger/postEntry';
import { createRecurring, postDue } from '../../src/ledger/recurring';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post, simple } from './ledgerTestDb';

const raise =
  (db: Database, sql: string, bind: (string | number | null)[] = []) =>
  () =>
    db.exec({ sql, bind });

async function setup() {
  const db = await newLedgerDb();
  const id = createRecurring(db, {
    name: 'Depreciation',
    frequency: 'monthly',
    dayOfMonth: 1,
    startDate: '2026-01-01',
    endDate: null,
    ref: null,
    payee: null,
    memo: null,
    lines: [
      { accountId: accountId(db, 'Depreciation'), debit: 100_00, credit: 0, memo: null },
      {
        accountId: accountId(db, 'Accumulated Depreciation'),
        debit: 0,
        credit: 100_00,
        memo: null,
      },
    ],
  });
  return { db, id };
}

describe('recurring entries in the schema (GL-5)', () => {
  it('records one run per template and date: a date can never post twice', async () => {
    const { db, id } = await setup();
    const [run] = postDue(db, '2026-01-01').posted;
    // A second entry for the same date can't be recorded as another run
    const again = postEntry(db, {
      ...simple(db, '2026-01-01', 'Depreciation', 'Accumulated Depreciation', 100_00),
      sourceType: 'recurring',
      sourceId: id,
    });
    expect(
      raise(
        db,
        `INSERT INTO recurring_run (recurring_id, date, company_id, entry_id) VALUES (?, '2026-01-01', (SELECT id FROM company), ?)`,
        [id, again],
      ),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(run!.date).toBe('2026-01-01');
  });

  it('a run must record that template’s own entry for that date', async () => {
    const { db, id } = await setup();
    const other = post(db, '2026-02-01', 'Meals', 'Checking', 10_00);
    expect(
      raise(
        db,
        `INSERT INTO recurring_run (recurring_id, date, company_id, entry_id) VALUES (?, '2026-02-01', (SELECT id FROM company), ?)`,
        [id, other],
      ),
    ).toThrow(/GL-5/);
  });

  it('keeps runs: no change, no delete, and a template that posted can’t be deleted', async () => {
    const { db, id } = await setup();
    postDue(db, '2026-01-01');
    expect(raise(db, `UPDATE recurring_run SET date = '2026-01-02'`)).toThrow(/GL-5/);
    expect(raise(db, `DELETE FROM recurring_run`)).toThrow(/GL-5/);
    expect(raise(db, `DELETE FROM recurring_line WHERE recurring_id = ?`, [id])).not.toThrow();
    expect(raise(db, `DELETE FROM recurring_entry WHERE id = ?`, [id])).toThrow(/GL-5/);
  });

  it('checks lines as journal lines do: one side, whole cents in range', async () => {
    const { db, id } = await setup();
    const add = (debit: number, credit: number) =>
      raise(
        db,
        `INSERT INTO recurring_line (company_id, recurring_id, line_no, account_id, debit, credit)
         VALUES ((SELECT id FROM company), ?, 9, ?, ?, ?)`,
        [id, accountId(db, 'Meals'), debit, credit],
      );
    expect(add(1_00, 1_00)).toThrow(/CHECK/);
    expect(add(-1, 0)).toThrow(/CHECK/);
  });
});
