import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccount,
  deleteAccount,
  listAccounts,
  setAccountActive,
  updateAccount,
} from '../../src/ledger/accounts';
import { trialBalance, fiscalYearStart } from '../../src/ledger/balances';
import { postEntry, validateEntry, voidEntry } from '../../src/ledger/postEntry';
import { DEFAULT_CHART } from '../../src/shared/accounts';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post, simple } from './ledgerTestDb';

const raise =
  (db: Database, sql: string, bind: (string | number | null)[] = []) =>
  () =>
    db.exec({ sql, bind });

describe('chart of accounts (GL-1, GL-2, GL-7)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
  });

  it('seeds the default chart, with the special accounts once each', () => {
    expect(listAccounts(db)).toHaveLength(DEFAULT_CHART.length);
    for (const dt of ['retained_earnings', 'opening_balance_equity', 'undeposited_funds']) {
      expect(db.selectValue('SELECT count(*) FROM account WHERE detail_type = ?', [dt])).toBe(1);
    }
    expect(
      db.selectValue(
        `SELECT count(*) FROM account WHERE detail_type IN ('accounts_receivable', 'accounts_payable')`,
      ),
    ).toBe(0);
  });

  it('pins special detail types to their account type', () => {
    expect(() => createAccount(db, { name: 'Odd', type: 'expense', detailType: 'bank' })).toThrow(
      /detail type/,
    );
    expect(
      raise(
        db,
        `INSERT INTO account (id, company_id, name, type, detail_type) VALUES ('x', (SELECT id FROM company), 'Odd', 'expense', 'bank')`,
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows only one retained earnings account', () => {
    expect(() =>
      createAccount(db, { name: 'RE 2', type: 'equity', detailType: 'retained_earnings' }),
    ).toThrow(/only one Retained earnings/);
  });

  it('keeps names unique among siblings, ignoring case, and numbers unique', () => {
    expect(() =>
      createAccount(db, { name: 'checking', type: 'asset', detailType: 'bank' }),
    ).toThrow(/already an account called checking/);
    const parent = accountId(db, 'Utilities');
    createAccount(db, {
      name: 'Checking',
      type: 'expense',
      detailType: 'utilities',
      parentId: parent,
    });
    createAccount(db, { name: 'Phone', number: '6760', type: 'expense', detailType: 'utilities' });
    expect(() =>
      createAccount(db, {
        name: 'Water',
        number: '6760',
        type: 'expense',
        detailType: 'utilities',
      }),
    ).toThrow(/6760 is already in use/);
  });

  it('builds sub-accounts with full names, and keeps them the parent type', () => {
    const utilities = accountId(db, 'Utilities');
    const phone = createAccount(db, {
      name: 'Phone',
      type: 'expense',
      detailType: 'utilities',
      parentId: utilities,
    });
    const mobile = createAccount(db, {
      name: 'Mobile',
      type: 'expense',
      detailType: 'utilities',
      parentId: phone,
    });
    const rows = listAccounts(db);
    const i = rows.findIndex((r) => r.id === utilities);
    expect(rows.slice(i, i + 3).map((r) => [r.fullName, r.depth])).toEqual([
      ['Utilities', 0],
      ['Utilities:Phone', 1],
      ['Utilities:Phone:Mobile', 2],
    ]);
    expect(() =>
      createAccount(db, {
        name: 'Bad',
        type: 'income',
        detailType: 'other_income',
        parentId: utilities,
      }),
    ).toThrow(/same type as its parent/);
    // No cycles
    expect(() =>
      updateAccount(db, utilities, {
        name: 'Utilities',
        type: 'expense',
        detailType: 'utilities',
        parentId: mobile,
      }),
    ).toThrow(/under its own sub-account/);
    // A parent keeps its type while it has sub-accounts
    expect(() =>
      updateAccount(db, utilities, {
        name: 'Utilities',
        type: 'income',
        detailType: 'other_income',
      }),
    ).toThrow(/sub-account|same type/);
  });

  it('deletes an account only while it has no history and no sub-accounts (GL-7)', () => {
    const spare = createAccount(db, {
      name: 'Spare',
      type: 'expense',
      detailType: 'other_expense',
    });
    deleteAccount(db, spare);
    post(db, '2026-01-05', 'Office Supplies and Software', 'Checking', 12_00);
    expect(() => deleteAccount(db, accountId(db, 'Checking'))).toThrow(/make it inactive instead/);
    const parent = accountId(db, 'Travel');
    createAccount(db, { name: 'Airfare', type: 'expense', detailType: 'travel', parentId: parent });
    expect(() => deleteAccount(db, parent)).toThrow(/sub-accounts first/);
  });

  it('inactivates accounts with history; inactive accounts take no postings (GL-7)', () => {
    post(db, '2026-01-05', 'Meals', 'Checking', 30_00);
    setAccountActive(db, accountId(db, 'Meals'), false);
    expect(listAccounts(db).find((a) => a.name === 'Meals')).toMatchObject({
      active: false,
      balance: 30_00,
      hasHistory: true,
    });
    expect(() => post(db, '2026-01-06', 'Meals', 'Checking', 5_00)).toThrow(/inactive/);
  });

  it('keeps the type of an account with history', () => {
    post(db, '2026-01-05', 'Meals', 'Checking', 30_00);
    expect(() =>
      updateAccount(db, accountId(db, 'Meals'), {
        name: 'Meals',
        type: 'asset',
        detailType: 'other_asset',
      }),
    ).toThrow(/keeps its type/);
  });
});

describe('journal entries (GL-3, GL-6)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
  });

  it('posts a balanced entry with its lines', () => {
    const id = post(db, '2026-02-01', 'Rent or Lease', 'Checking', 1_500_00, {
      ref: '1042',
      memo: 'February rent',
    });
    expect(db.selectObjects('SELECT status, date FROM journal_entry WHERE id = ?', [id])).toEqual([
      { status: 'posted', date: '2026-02-01' },
    ]);
    expect(
      db.selectArrays(
        'SELECT line_no, debit, credit FROM journal_line WHERE entry_id = ? ORDER BY line_no',
        [id],
      ),
    ).toEqual([
      [1, 1_500_00, 0],
      [2, 0, 1_500_00],
    ]);
  });

  it('refuses unbalanced, one-line and empty entries, in TypeScript and in the schema', () => {
    const e = simple(db, '2026-02-01', 'Meals', 'Checking', 10_00);
    e.lines[1]!.credit = 9_99;
    expect(validateEntry(e)).toContain('Debits and credits must be equal.');
    expect(() => postEntry(db, e)).toThrow(/Debits and credits must be equal/);

    // Straight at the schema, bypassing postEntry()
    db.exec(
      `INSERT INTO journal_entry (id, company_id, date, source_type) VALUES (900, (SELECT id FROM company), '2026-02-01', 'journal')`,
    );
    const line = (n: number, account: string, debit: number, credit: number) =>
      db.exec({
        sql: `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit, credit) VALUES ((SELECT id FROM company), 900, ?, ?, ?, ?)`,
        bind: [n, accountId(db, account), debit, credit],
      });
    const postIt = raise(db, `UPDATE journal_entry SET status = 'posted' WHERE id = 900`);
    expect(postIt).toThrow(/at least two lines/);
    line(1, 'Meals', 10_00, 0);
    expect(postIt).toThrow(/at least two lines/);
    line(2, 'Checking', 0, 9_99);
    expect(postIt).toThrow(/debits and credits must be equal/);
    db.exec(
      `UPDATE journal_line SET credit = 10_00 WHERE entry_id = 900 AND line_no = 2`.replace(
        '10_00',
        '1000',
      ),
    );
    postIt();
    expect(db.selectValue('SELECT status FROM journal_entry WHERE id = 900')).toBe('posted');
  });

  it('refuses entries that move no money, lines with both sides, negatives and fractions', () => {
    db.exec(
      `INSERT INTO journal_entry (id, company_id, date, source_type) VALUES (901, (SELECT id FROM company), '2026-02-01', 'journal')`,
    );
    const line = (n: number, debit: number, credit: number) =>
      raise(
        db,
        `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit, credit) VALUES ((SELECT id FROM company), 901, ?, ?, ?, ?)`,
        [n, accountId(db, 'Meals'), debit, credit],
      );
    expect(line(1, 5, 5)).toThrow(/CHECK constraint failed/);
    expect(line(1, -5, 0)).toThrow(/CHECK constraint failed/);
    expect(line(1, 1.5, 0)).toThrow(/REAL value in INTEGER column/);
    line(1, 0, 0)();
    line(2, 0, 0)();
    expect(raise(db, `UPDATE journal_entry SET status = 'posted' WHERE id = 901`)).toThrow(
      /must move some money/,
    );
  });

  it('creates entries only as drafts', () => {
    expect(
      raise(
        db,
        `INSERT INTO journal_entry (company_id, date, source_type, status) VALUES ((SELECT id FROM company), '2026-02-01', 'journal', 'posted')`,
      ),
    ).toThrow(/created as drafts/);
  });

  it('never changes or deletes a posted entry or its lines (GL-6)', () => {
    const id = post(db, '2026-02-01', 'Meals', 'Checking', 10_00);
    expect(
      raise(db, 'UPDATE journal_line SET debit = 1 WHERE entry_id = ? AND line_no = 1', [id]),
    ).toThrow(/cannot be changed/);
    expect(raise(db, 'DELETE FROM journal_line WHERE entry_id = ?', [id])).toThrow(
      /cannot be deleted/,
    );
    expect(
      raise(
        db,
        `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit) VALUES ((SELECT id FROM company), ?, 3, ?, 1)`,
        [id, accountId(db, 'Meals')],
      ),
    ).toThrow(/only be added to a draft/);
    expect(raise(db, `UPDATE journal_entry SET memo = 'edited' WHERE id = ?`, [id])).toThrow(
      /cannot be changed/,
    );
    expect(raise(db, `UPDATE journal_entry SET date = '2026-03-01' WHERE id = ?`, [id])).toThrow(
      /cannot be changed/,
    );
    expect(raise(db, 'DELETE FROM journal_entry WHERE id = ?', [id])).toThrow(/never deleted/);
  });

  it('corrects by voiding: lines stay, the entry leaves the balances, and it never comes back', () => {
    const id = post(db, '2026-02-01', 'Meals', 'Checking', 10_00);
    voidEntry(db, id, 'Entered twice');
    expect(
      db.selectObjects('SELECT status, void_reason FROM journal_entry WHERE id = ?', [id]),
    ).toEqual([{ status: 'void', void_reason: 'Entered twice' }]);
    expect(db.selectValue('SELECT count(*) FROM journal_line WHERE entry_id = ?', [id])).toBe(2);
    expect(listAccounts(db).find((a) => a.name === 'Meals')!.balance).toBe(0);
    expect(() => voidEntry(db, id, null)).toThrow(/already void/);
    expect(raise(db, `UPDATE journal_entry SET status = 'posted' WHERE id = ?`, [id])).toThrow(
      /draft to posted, or from posted to void|cannot be changed/,
    );
    expect(
      raise(db, `UPDATE journal_entry SET void_reason = 'changed' WHERE id = ?`, [id]),
    ).toThrow(/cannot be changed/);
    expect(raise(db, 'DELETE FROM journal_entry WHERE id = ?', [id])).toThrow(/never deleted/);
  });

  it('lets an unposted draft be thrown away', () => {
    db.exec(
      `INSERT INTO journal_entry (id, company_id, date, source_type) VALUES (902, (SELECT id FROM company), '2026-02-01', 'journal')`,
    );
    db.exec({
      sql: `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit) VALUES ((SELECT id FROM company), 902, 1, ?, 1)`,
      bind: [accountId(db, 'Meals')],
    });
    db.exec('DELETE FROM journal_line WHERE entry_id = 902');
    db.exec('DELETE FROM journal_entry WHERE id = 902');
    expect(db.selectValue('SELECT count(*) FROM journal_entry WHERE id = 902')).toBe(0);
  });

  it('leaves nothing behind when posting fails', () => {
    const before = db.selectValue('SELECT count(*) FROM journal_entry');
    const e = simple(db, '2026-02-01', 'Meals', 'Checking', 10_00);
    e.lines[0]!.accountId = 'no-such-account';
    expect(() => postEntry(db, e)).toThrow();
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(before);
  });

  it('records posting and voiding an entry in the audit log, compactly, with the user (US-5)', () => {
    const id = post(db, '2026-02-01', 'Meals', 'Checking', 10_00, { ref: 'R1', memo: 'Lunch' });
    voidEntry(db, id, 'test');
    const rows = db.selectObjects(
      `SELECT action, entity, entity_id, user_id, before, after FROM audit_event WHERE entity IN ('journal_entry', 'journal_line') ORDER BY id`,
    );
    expect(rows.map((r) => [r.action, r.entity, r.entity_id, r.before])).toEqual([
      ['post', 'journal_entry', String(id), null],
      ['void', 'journal_entry', String(id), null],
    ]);
    expect(rows.every((r) => r.user_id !== null)).toBe(true);
    expect(JSON.parse(String(rows[0]!.after))).toEqual({
      date: '2026-02-01',
      ref: 'R1',
      memo: 'Lunch',
      source_type: 'journal',
      source_id: null,
      amount: 10_00,
    });
    expect(JSON.parse(String(rows[1]!.after))).toEqual({ date: '2026-02-01', void_reason: 'test' });
  });

  it('does not copy journal lines or drafts into the audit log', () => {
    post(db, '2026-02-01', 'Meals', 'Checking', 10_00);
    expect(db.selectValue(`SELECT count(*) FROM audit_event WHERE entity = 'journal_line'`)).toBe(
      0,
    );
    expect(
      db.selectValue(
        `SELECT count(*) FROM audit_event WHERE action = 'insert' AND entity = 'journal_entry'`,
      ),
    ).toBe(0);
    expect(
      db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE name LIKE 'audit__journal%'`),
    ).toBe(0);
  });
});

describe('cash-basis ledger (GL-8)', () => {
  it('refuses A/R and A/P postings except from migrated history', async () => {
    const db = await newLedgerDb();
    createAccount(db, {
      name: 'Accounts Receivable',
      type: 'asset',
      detailType: 'accounts_receivable',
    });
    createAccount(db, {
      name: 'Accounts Payable',
      type: 'liability',
      detailType: 'accounts_payable',
    });
    expect(() => post(db, '2026-01-10', 'Accounts Receivable', 'Sales', 100_00)).toThrow(
      /cash basis/,
    );
    expect(() => post(db, '2026-01-10', 'Rent or Lease', 'Accounts Payable', 100_00)).toThrow(
      /cash basis/,
    );
    expect(() =>
      postEntry(
        db,
        simple(db, '2016-01-10', 'Accounts Receivable', 'Sales', 100_00, {
          sourceType: 'qbo_migration',
        }),
      ),
    ).not.toThrow();
  });
});

describe('closing date (PC-1, PC-2)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
    db.exec(`UPDATE company SET closing_date = '2025-12-31'`);
  });

  it('refuses postings on or before the closing date, and accepts later ones', () => {
    expect(() => post(db, '2025-12-31', 'Meals', 'Checking', 10_00)).toThrow(
      expect.objectContaining({ name: 'ClosedPeriodError' }),
    );
    expect(() => post(db, '2026-01-01', 'Meals', 'Checking', 10_00)).not.toThrow();
  });

  it('refuses voiding an entry in a closed period', () => {
    db.exec(`UPDATE company SET closing_date = NULL`);
    const id = post(db, '2025-06-30', 'Meals', 'Checking', 10_00);
    db.exec(`UPDATE company SET closing_date = '2025-12-31'`);
    expect(() => voidEntry(db, id, null)).toThrow(
      expect.objectContaining({ name: 'ClosedPeriodError' }),
    );
  });

  it('allows an owner override for one action, logs it, and clears it', () => {
    const id = postEntry(db, simple(db, '2025-11-15', 'Meals', 'Checking', 10_00), {
      closingOverride: true,
    });
    expect(db.selectValue('SELECT closing_override FROM session')).toBe(0);
    expect(() => post(db, '2025-11-16', 'Meals', 'Checking', 10_00)).toThrow(/closed period/);
    voidEntry(db, id, 'mistake', { closingOverride: true });
    expect(
      db.selectArrays(
        `SELECT action, entity_id, note FROM audit_event WHERE action = 'closed_period_override' ORDER BY id`,
      ),
    ).toEqual([
      [
        'closed_period_override',
        String(id),
        'posted an entry dated 2025-11-15 (closing date 2025-12-31)',
      ],
      [
        'closed_period_override',
        String(id),
        'voided an entry dated 2025-11-15 (closing date 2025-12-31)',
      ],
    ]);
  });

  it('clears the override even when the overridden posting fails', () => {
    const e = simple(db, '2025-11-15', 'Meals', 'Checking', 10_00);
    e.lines[1]!.credit = 1;
    expect(() => postEntry(db, e, { closingOverride: true })).toThrow();
    expect(db.selectValue('SELECT closing_override FROM session')).toBe(0);
  });

  it('only accepts real dates as the closing date', () => {
    expect(raise(db, `UPDATE company SET closing_date = '2025-02-30'`)).toThrow(
      /CHECK constraint failed/,
    );
  });
});

describe('trial balance and year-end (PC-3)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
  });

  it('finds the fiscal year start', () => {
    expect(fiscalYearStart('2026-10-26', 1)).toBe('2026-01-01');
    expect(fiscalYearStart('2026-03-15', 7)).toBe('2025-07-01');
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
  });

  it('rolls earlier years’ net income into retained earnings, without changing the ledger', () => {
    post(db, '2025-03-01', 'Checking', 'Services', 1_000_00);
    post(db, '2025-04-01', 'Rent or Lease', 'Checking', 300_00);
    post(db, '2026-02-01', 'Checking', 'Services', 500_00);
    const rows = (asOf: string) =>
      Object.fromEntries(trialBalance(db, asOf).rows.map((r) => [r.account, r.debit - r.credit]));

    expect(rows('2025-12-31')).toEqual({
      Checking: 700_00,
      Services: -1_000_00,
      'Rent or Lease': 300_00,
    });
    expect(rows('2026-12-31')).toEqual({
      Checking: 1_200_00,
      'Retained Earnings': -700_00,
      Services: -500_00,
    });
    const tb = trialBalance(db, '2026-12-31');
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(
      db.selectValue(
        `SELECT count(*) FROM journal_line l JOIN account a ON a.id = l.account_id WHERE a.detail_type = 'retained_earnings'`,
      ),
    ).toBe(0);
  });

  it('follows a fiscal year that starts in July', () => {
    db.exec('UPDATE company SET fiscal_year_start_month = 7');
    post(db, '2026-06-30', 'Checking', 'Services', 100_00);
    post(db, '2026-07-01', 'Checking', 'Services', 40_00);
    const tb = trialBalance(db, '2026-07-31');
    expect(tb.fiscalYearStart).toBe('2026-07-01');
    expect(tb.rows.find((r) => r.account === 'Services')!.credit).toBe(40_00);
    expect(tb.rows.find((r) => r.account === 'Retained Earnings')!.credit).toBe(100_00);
  });

  it('leaves out void entries and anything after the date', () => {
    const id = post(db, '2026-01-10', 'Meals', 'Checking', 10_00);
    voidEntry(db, id, null);
    post(db, '2026-02-10', 'Meals', 'Checking', 7_00);
    expect(trialBalance(db, '2026-01-31').rows).toEqual([]);
    expect(trialBalance(db, '2026-02-28').rows.map((r) => r.account)).toEqual([
      'Checking',
      'Meals',
    ]);
  });

  it('always balances, whatever is posted', async () => {
    const names = [
      'Checking',
      'Savings',
      'Credit Card',
      'Sales',
      'Services',
      'Meals',
      'Travel',
      "Owner's Draw",
    ];
    const fresh = await newLedgerDb();
    const ids = names.map((n) => accountId(fresh, n));
    await fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 0, max: 3 * 365 }),
            from: fc.integer({ min: 0, max: names.length - 1 }),
            to: fc.integer({ min: 0, max: names.length - 1 }),
            cents: fc.integer({ min: 1, max: 5_000_000_00 }),
          }),
          { maxLength: 15 },
        ),
        fc.integer({ min: 0, max: 3 * 365 }),
        (entries, asOfDay) => {
          const day = (n: number) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10);
          fresh.exec('SAVEPOINT prop');
          try {
            for (const e of entries.filter((x) => x.from !== x.to)) {
              postEntry(fresh, {
                date: day(e.day),
                sourceType: 'journal',
                lines: [
                  { accountId: ids[e.to]!, debit: e.cents, credit: 0 },
                  { accountId: ids[e.from]!, debit: 0, credit: e.cents },
                ],
              });
            }
            const tb = trialBalance(fresh, day(asOfDay));
            expect(tb.totalDebit).toBe(tb.totalCredit);
          } finally {
            fresh.exec('ROLLBACK TO prop');
            fresh.exec('RELEASE prop');
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
