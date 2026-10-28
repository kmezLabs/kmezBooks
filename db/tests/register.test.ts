import { beforeEach, describe, expect, it } from 'vitest';
import { postEntry } from '../../src/ledger/postEntry';
import { register, simpleToEntry } from '../../src/ledger/register';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post } from './ledgerTestDb';

let db: Database;
let checking: string;

beforeEach(async () => {
  db = await newLedgerDb();
  checking = accountId(db, 'Checking');
  post(db, '2026-01-03', 'Checking', 'Services', 5_000_00, { name: 'Acme', ref: 'INV-1' });
  post(db, '2026-01-05', 'Utilities', 'Checking', 45_00, { name: 'Power Co' });
  post(db, '2026-01-07', 'Savings', 'Checking', 1_000_00, { memo: 'To savings' }); // a transfer
  postEntry(db, {
    date: '2026-01-09',
    name: 'Office Depot',
    sourceType: 'journal',
    lines: [
      {
        accountId: accountId(db, 'Office Supplies and Software'),
        debit: 80_00,
        credit: 0,
        memo: 'Paper',
      },
      { accountId: accountId(db, 'Meals'), debit: 20_00, credit: 0 },
      { accountId: accountId(db, 'Credit Card'), debit: 0, credit: 100_00 },
    ],
  });
});

describe('transactions register (GL-9)', () => {
  it('lists income and expenses newest first, with categories, accounts and totals', () => {
    const r = register(db);
    expect(
      r.rows.map((x) => [x.date, x.name, x.categories, x.accounts, x.income, x.expense]),
    ).toEqual([
      [
        '2026-01-09',
        'Office Depot',
        'Office Supplies and Software, Meals',
        'Credit Card',
        0,
        100_00,
      ],
      ['2026-01-05', 'Power Co', 'Utilities', 'Checking', 0, 45_00],
      ['2026-01-03', 'Acme', 'Services', 'Checking', 5_000_00, 0],
    ]);
    expect(r).toMatchObject({ count: 3, totals: { income: 5_000_00, expense: 145_00 } });
  });

  it('filters by account, dates, text and scope, and sorts oldest first', () => {
    expect(register(db, { scope: 'all' }).count).toBe(4);
    expect(
      register(db, { scope: 'all', accountId: checking, order: 'asc' }).rows.map((x) => x.date),
    ).toEqual(['2026-01-03', '2026-01-05', '2026-01-07']);
    expect(register(db, { from: '2026-01-04', to: '2026-01-08' }).rows.map((x) => x.name)).toEqual([
      'Power Co',
    ]);
    expect(register(db, { search: 'inv-' }).rows.map((x) => x.name)).toEqual(['Acme']);
    expect(register(db, { limit: 1, offset: 1 }).rows.map((x) => x.name)).toEqual(['Power Co']);
  });

  it('pages oldest first from the latest, so a register opens at its end', () => {
    const r = register(db, { scope: 'all', order: 'asc', limit: 2 });
    expect(r.rows.map((x) => x.date)).toEqual(['2026-01-07', '2026-01-09']);
    expect(
      register(db, { scope: 'all', order: 'asc', limit: 2, offset: 2 }).rows.map((x) => x.date),
    ).toEqual(['2026-01-03', '2026-01-05']);
  });

  it('gives an account’s balance after each entry, counting entries the filter leaves out', () => {
    const r = register(db, {
      scope: 'all',
      accountId: checking,
      balanceAccountId: checking,
      order: 'asc',
    });
    expect(r.rows.map((x) => [x.date, x.accountAmount, x.balance])).toEqual([
      ['2026-01-03', 5_000_00, 5_000_00],
      ['2026-01-05', -45_00, 4_955_00],
      ['2026-01-07', -1_000_00, 3_955_00],
    ]);
    // Only the last one shown: its balance still includes the earlier ones
    const searched = register(db, {
      scope: 'all',
      accountId: checking,
      balanceAccountId: checking,
      search: 'savings',
    });
    expect(searched.rows.map((x) => x.balance)).toEqual([3_955_00]);
    // A card: charges lower the balance (what's owed is negative, debit minus credit)
    const card = accountId(db, 'Credit Card');
    expect(
      register(db, { accountId: card, balanceAccountId: card }).rows.map((x) => x.balance),
    ).toEqual([-100_00]);
    // No balance without an account
    expect(register(db).rows.every((x) => x.balance === null && x.accountAmount === null)).toBe(
      true,
    );
  });

  it('shows each entry as paid from or deposited to one account, split over categories', () => {
    const rows = register(db, { scope: 'all' }).rows;
    const byName = (n: string | null) => rows.find((x) => x.name === n)!.simple;
    expect(byName('Acme')).toEqual({
      kind: 'income',
      moneyAccountId: checking,
      lines: [{ accountId: accountId(db, 'Services'), amount: 5_000_00, memo: null }],
    });
    expect(byName('Office Depot')).toMatchObject({
      kind: 'expense',
      moneyAccountId: accountId(db, 'Credit Card'),
      lines: [
        { amount: 80_00, memo: 'Paper' },
        { amount: 20_00, memo: null },
      ],
    });
    // A transfer: money leaves Checking
    expect(byName(null)).toMatchObject({ kind: 'expense', moneyAccountId: checking });
    // Two lines on each side has no simple shape
    const complex = postEntry(db, {
      date: '2026-01-10',
      name: 'Complex',
      sourceType: 'journal',
      lines: [
        { accountId: accountId(db, 'Utilities'), debit: 10_00, credit: 0 },
        { accountId: accountId(db, 'Meals'), debit: 10_00, credit: 0 },
        { accountId: checking, debit: 0, credit: 15_00 },
        { accountId: accountId(db, 'Credit Card'), debit: 0, credit: 5_00 },
      ],
    });
    expect(register(db).rows.find((x) => x.id === complex)!.simple).toBeNull();
  });

  it('turns the quick form into balanced lines, refusing what doesn’t add up', () => {
    const utilities = accountId(db, 'Utilities');
    const entry = simpleToEntry(
      {
        kind: 'expense',
        moneyAccountId: checking,
        lines: [{ accountId: utilities, amount: 45_00, memo: null }],
      },
      { date: '2026-02-01', name: 'Power Co' },
    );
    expect(entry.lines).toEqual([
      { accountId: checking, debit: 0, credit: 45_00 },
      { accountId: utilities, debit: 45_00, credit: 0, memo: null },
    ]);
    const income = simpleToEntry(
      {
        kind: 'income',
        moneyAccountId: checking,
        lines: [{ accountId: accountId(db, 'Services'), amount: 10_00, memo: null }],
      },
      { date: '2026-02-01' },
    );
    expect(income.lines[0]).toEqual({ accountId: checking, debit: 10_00, credit: 0 });
    const bad = (moneyAccountId: string, accountId: string, amount: number) => () =>
      simpleToEntry(
        { kind: 'expense', moneyAccountId, lines: [{ accountId, amount, memo: null }] },
        { date: '2026-02-01' },
      );
    expect(bad('', utilities, 1)).toThrow('Choose the account it was paid from');
    expect(bad(checking, '', 1)).toThrow('Choose a category for each line');
    expect(bad(checking, checking, 1)).toThrow('can’t be the account');
    expect(bad(checking, utilities, 0)).toThrow('above zero');
  });
});
