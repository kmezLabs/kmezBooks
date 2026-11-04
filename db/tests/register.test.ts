import { beforeEach, describe, expect, it } from 'vitest';
import { postEntry } from '../../src/ledger/postEntry';
import { register, registerAccounts, simpleToEntry } from '../../src/ledger/register';
import { setAccountActive } from '../../src/ledger/accounts';
import {
  finishReconciliation,
  reconcileState,
  setCleared,
  startReconciliation,
} from '../../src/modules/banking/reconcile';
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

  it('filters by payee, on the entry or a line (GL-11)', () => {
    postEntry(db, {
      date: '2026-01-11',
      name: 'Owner',
      sourceType: 'journal',
      lines: [
        { accountId: accountId(db, 'Utilities'), debit: 30_00, credit: 0, name: 'power co' },
        { accountId: checking, debit: 0, credit: 30_00 },
      ],
    });
    const power = String(db.selectValue(`SELECT id FROM payee WHERE name = 'Power Co'`));
    expect(register(db, { scope: 'all', payeeId: power }).rows.map((r) => r.date)).toEqual([
      '2026-01-11',
      '2026-01-05',
    ]);
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
    // A transfer (GL-14): from Checking to Savings
    expect(byName(null)).toEqual({
      kind: 'transfer',
      moneyAccountId: checking,
      lines: [{ accountId: accountId(db, 'Savings'), amount: 1_000_00, memo: null }],
    });
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

  it('records an expense split across categories, with or without a payee (EX-1, EX-3)', () => {
    const card = accountId(db, 'Credit Card');
    const supplies = accountId(db, 'Office Supplies and Software');
    const meals = accountId(db, 'Meals');
    const entry = simpleToEntry(
      {
        kind: 'expense',
        moneyAccountId: card,
        lines: [
          { accountId: supplies, amount: 12_34, memo: 'Toner' },
          { accountId: meals, amount: 7_66, memo: null },
          // A blank line left in the form is ignored
          { accountId: '', amount: 0, memo: null },
        ],
      },
      { date: '2026-02-02', ref: '1001' },
    );
    expect(entry.name).toBeUndefined();
    expect(entry.lines).toEqual([
      { accountId: card, debit: 0, credit: 20_00 },
      { accountId: supplies, debit: 12_34, credit: 0, memo: 'Toner' },
      { accountId: meals, debit: 7_66, credit: 0, memo: null },
    ]);
    const id = postEntry(db, { ...entry, sourceType: 'journal' });
    const row = register(db).rows.find((x) => x.id === id)!;
    expect(row).toMatchObject({ ref: '1001', name: null, status: 'posted' });
    expect(row.simple).toMatchObject({ kind: 'expense', moneyAccountId: card });
    expect(row.simple!.lines.map((l) => l.amount)).toEqual([12_34, 7_66]);
  });

  it('turns the quick form into balanced lines, refusing what doesn’t add up (EX-1)', () => {
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

describe('the Accounts register (GL-13)', () => {
  it('marks entries reconciled (R) or cleared in the open reconciliation (C)', () => {
    // Checking: +5,000 on Jan 3, -45 on Jan 5, -1,000 on Jan 7
    const done = startReconciliation(db, checking, '2026-01-04', 5_000_00);
    const line = (date: string) =>
      reconcileState(db, checking).items.find((i) => i.date === date)!.lineId;
    setCleared(db, done, [line('2026-01-03')], true);
    finishReconciliation(db, done);
    const open = startReconciliation(db, checking, '2026-01-31', 3_955_00);
    setCleared(db, open, [line('2026-01-05')], true);

    const rows = register(db, {
      scope: 'all',
      accountId: checking,
      balanceAccountId: checking,
      order: 'asc',
    }).rows;
    expect(rows.map((r) => [r.date, r.reconciled, r.otherSide])).toEqual([
      ['2026-01-03', 'R', 'Services'],
      ['2026-01-05', 'C', 'Utilities'],
      ['2026-01-07', null, 'Savings'],
    ]);
    // Without a register account there is nothing to mark
    expect(register(db, { scope: 'all' }).rows.every((r) => r.reconciled === null)).toBe(true);
  });

  it('lists every account by type, with balances and the last reconciliation', () => {
    const done = startReconciliation(db, checking, '2026-01-04', 5_000_00);
    setCleared(db, done, [reconcileState(db, checking).items[0]!.lineId], true);
    finishReconciliation(db, done);
    const all = registerAccounts(db);
    const of = (name: string) => all.find((a) => a.name === name)!;
    // Assets first, as the chart lists them, then by name; expenses last
    expect(all[0]!.type).toBe('asset');
    expect(all.at(-1)!.type).toBe('expense');
    expect(all.map((a) => a.name).indexOf('Checking')).toBeLessThan(
      all.map((a) => a.name).indexOf('Savings'),
    );
    expect([of('Checking').balance, of('Savings').balance, of('Credit Card').balance]).toEqual([
      3_955_00, 1_000_00, -100_00,
    ]);
    expect([of('Services').balance, of('Utilities').balance]).toEqual([-5_000_00, 45_00]);
    expect(of('Checking').reconciled).toEqual({ date: '2026-01-04', balance: 5_000_00 });
    expect(of('Savings').reconciled).toBeNull();
    // An inactive account shows only while it still holds a balance
    setAccountActive(db, accountId(db, 'Petty Cash'), false);
    setAccountActive(db, accountId(db, 'Savings'), false);
    const names = registerAccounts(db).map((a) => a.name);
    expect(names.includes('Petty Cash')).toBe(false);
    expect(names.includes('Savings')).toBe(true);
  });
});

describe('transfers (GL-14)', () => {
  it('posts from one account to another, and refuses the same account or no amount', () => {
    const card = accountId(db, 'Credit Card');
    const entry = simpleToEntry(
      {
        kind: 'transfer',
        moneyAccountId: checking,
        lines: [{ accountId: card, amount: 100_00, memo: null }],
      },
      { date: '2026-02-01', memo: 'Card payment' },
    );
    expect(entry.lines).toEqual([
      { accountId: checking, debit: 0, credit: 100_00 },
      { accountId: card, debit: 100_00, credit: 0, memo: null },
    ]);
    const id = postEntry(db, { ...entry, sourceType: 'register' });
    const row = register(db, { scope: 'all', accountId: card, balanceAccountId: card }).rows.find(
      (r) => r.id === id,
    )!;
    expect(row).toMatchObject({ otherSide: 'Checking', accountAmount: 100_00, balance: 0 });
    expect(row.simple).toMatchObject({ kind: 'transfer', moneyAccountId: checking });

    const bad = (from: string, to: string, amount: number) => () =>
      simpleToEntry(
        { kind: 'transfer', moneyAccountId: from, lines: [{ accountId: to, amount, memo: null }] },
        { date: '2026-02-01' },
      );
    expect(bad('', card, 1)).toThrow('came from');
    expect(bad(checking, '', 1)).toThrow('went to');
    expect(bad(checking, checking, 1)).toThrow('two different accounts');
    expect(bad(checking, card, 0)).toThrow('above zero');
  });
});
