import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts';
import { fiscalYearStart } from '../../src/ledger/balances';
import { postEntry, voidEntry } from '../../src/ledger/postEntry';
import {
  balanceSheet,
  generalLedger,
  percentOf,
  profitAndLoss,
  runReport,
  trialBalanceReport,
} from '../../src/ledger/reports';
import type { Report } from '../../src/shared/report';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post } from './ledgerTestDb';

const row = (r: Report, label: string) => r.rows.find((x) => x.cells[0] === label);
const amount = (r: Report, label: string) => row(r, label)?.cells[1];
const labels = (r: Report) => r.rows.map((x) => `${' '.repeat(x.depth * 2)}${x.cells[0]}`);

describe('profit and loss (RP-1)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
    const utilities = accountId(db, 'Utilities');
    createAccount(db, {
      name: 'Phone',
      type: 'expense',
      detailType: 'utilities',
      parentId: utilities,
    });
    post(db, '2026-01-10', 'Checking', 'Services', 5_000_00);
    post(db, '2026-01-12', 'Checking', 'Sales', 1_000_00);
    post(db, '2026-01-15', 'Cost of Goods Sold', 'Checking', 400_00);
    post(db, '2026-01-20', 'Rent or Lease', 'Checking', 1_500_00);
    post(db, '2026-01-21', 'Utilities', 'Checking', 100_00);
    post(db, '2026-01-22', 'Phone', 'Checking', 60_00);
    post(db, '2025-12-31', 'Checking', 'Services', 999_00); // outside the range
    voidEntry(db, post(db, '2026-01-25', 'Meals', 'Checking', 50_00), 'void'); // void: left out
  });

  it('lays out income, cost of goods sold, gross profit, expenses and net income', () => {
    const r = profitAndLoss(db, { kind: 'pl', from: '2026-01-01', to: '2026-01-31' });
    expect(labels(r)).toEqual([
      'Income',
      '  Sales',
      '  Services',
      'Total Income',
      'Cost of Goods Sold',
      '  Cost of Goods Sold',
      'Total Cost of Goods Sold',
      'Gross Profit',
      'Expenses',
      '  Rent or Lease',
      '  Utilities',
      '    Phone',
      '  Total Utilities',
      'Total Expenses',
      'Net Income',
    ]);
    expect(amount(r, 'Total Income')).toBe(6_000_00);
    expect(amount(r, 'Gross Profit')).toBe(5_600_00);
    expect(amount(r, 'Utilities')).toBe(100_00);
    expect(amount(r, 'Total Utilities')).toBe(160_00);
    expect(amount(r, 'Total Expenses')).toBe(1_660_00);
    expect(amount(r, 'Net Income')).toBe(3_940_00);
    expect(r).toMatchObject({
      title: 'Profit and Loss',
      basis: 'Cash basis',
      period: 'January 1, 2026 – January 31, 2026',
    });
  });

  it('drills from an account figure to its lines for the same period (RP-5)', () => {
    const r = profitAndLoss(db, { kind: 'pl', from: '2026-01-01', to: '2026-01-31' });
    expect(row(r, 'Services')!.drill).toEqual({
      kind: 'account',
      accountId: accountId(db, 'Services'),
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(row(r, 'Total Income')!.drill).toBeUndefined();
  });

  it('shows an empty period as zeros', () => {
    const r = profitAndLoss(db, { kind: 'pl', from: '2027-01-01', to: '2027-01-31' });
    expect(labels(r)).toEqual([
      'Income',
      'Total Income',
      'Expenses',
      'Total Expenses',
      'Net Income',
    ]);
    expect(amount(r, 'Net Income')).toBe(0);
  });

  it('adds each figure as a percentage of total income when asked (RP-10)', () => {
    const plain = profitAndLoss(db, { kind: 'pl', from: '2026-01-01', to: '2026-01-31' });
    expect(plain.columns).toHaveLength(2);
    expect(plain.rows.every((x) => x.cells.length === 2)).toBe(true);

    const r = profitAndLoss(db, {
      kind: 'pl',
      from: '2026-01-01',
      to: '2026-01-31',
      percentOfIncome: true,
    });
    expect(r.columns[2]).toEqual({ label: '% of Income', numeric: true, unit: 'percent' });
    const pct = (label: string) => row(r, label)?.cells[2];
    expect(pct('Income')).toBeNull(); // heading
    expect(pct('Sales')).toBe(16_67);
    expect(pct('Services')).toBe(83_33);
    expect(pct('Total Income')).toBe(100_00);
    expect(pct('Gross Profit')).toBe(93_33);
    expect(pct('Utilities')).toBe(1_67);
    expect(pct('Phone')).toBe(1_00);
    expect(pct('Total Utilities')).toBe(2_67);
    expect(pct('Total Expenses')).toBe(27_67);
    expect(pct('Net Income')).toBe(65_67);
    expect(amount(r, 'Net Income')).toBe(3_940_00);
  });

  it('leaves percentages blank when there is no income (RP-10)', () => {
    const r = profitAndLoss(db, {
      kind: 'pl',
      from: '2027-01-01',
      to: '2027-01-31',
      percentOfIncome: true,
    });
    expect(r.rows.map((x) => x.cells[2])).toEqual([null, null, null, null, null]);
  });

  it('rounds percentages half away from zero, by the sign of income too (RP-10)', () => {
    expect(percentOf(1, 20_000n)).toBe(1); // 0.005% → 0.01%
    expect(percentOf(-1, 20_000n)).toBe(-1);
    expect(percentOf(1, 30_000n)).toBe(0);
    expect(percentOf(100, -1_000n)).toBe(-10_00);
    expect(percentOf(-100, -1_000n)).toBe(10_00);
    expect(percentOf(5, 0n)).toBeNull();
    expect(percentOf(Number.MAX_SAFE_INTEGER, 1n)).toBeNull(); // too large to show
  });
});

describe('balance sheet (RP-2, PC-3)', () => {
  it('balances, with earlier years in retained earnings and this year as net income', async () => {
    const db = await newLedgerDb();
    post(db, '2025-01-05', 'Checking', "Owner's Investment", 10_000_00);
    post(db, '2025-06-01', 'Checking', 'Services', 3_000_00);
    post(db, '2025-07-01', 'Rent or Lease', 'Checking', 1_000_00);
    post(db, '2026-02-01', 'Checking', 'Services', 500_00);
    post(db, '2026-02-02', 'Office Supplies and Software', 'Credit Card', 200_00);
    const r = balanceSheet(db, { kind: 'bs', to: '2026-03-31' });
    expect(amount(r, 'Checking')).toBe(12_500_00);
    expect(amount(r, 'Total Assets')).toBe(12_500_00);
    expect(amount(r, 'Credit Card')).toBe(200_00);
    expect(amount(r, "Owner's Investment")).toBe(10_000_00);
    expect(amount(r, 'Retained Earnings')).toBe(2_000_00);
    expect(amount(r, 'Net Income')).toBe(300_00);
    expect(amount(r, 'Total Liabilities and Equity')).toBe(12_500_00);
    expect(r.notes).toEqual([]);
    expect(row(r, 'Retained Earnings')!.drill).toEqual({
      kind: 'pl',
      from: null,
      to: '2025-12-31',
    });
    expect(row(r, 'Net Income')!.drill).toEqual({
      kind: 'pl',
      from: '2026-01-01',
      to: '2026-03-31',
    });
    expect(row(r, 'Checking')!.drill).toEqual({
      kind: 'account',
      accountId: accountId(db, 'Checking'),
      from: null,
      to: '2026-03-31',
    });
  });

  it('always balances, and its net income matches the P&L for the fiscal year to date', async () => {
    const db = await newLedgerDb();
    const names = [
      'Checking',
      'Savings',
      'Credit Card',
      'Loan Payable',
      "Owner's Investment",
      "Owner's Draw",
      'Sales',
      'Services',
      'Meals',
      'Cost of Goods Sold',
    ];
    const ids = names.map((n) => accountId(db, n));
    const day = (n: number) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 0, max: 1000 }),
            dr: fc.integer({ min: 0, max: names.length - 1 }),
            cr: fc.integer({ min: 0, max: names.length - 1 }),
            cents: fc.integer({ min: 1, max: 10_000_000_00 }),
          }),
          { maxLength: 12 },
        ),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 12 }),
        (entries, asOfDay, fyMonth) => {
          db.exec('SAVEPOINT prop');
          try {
            db.exec({ sql: 'UPDATE company SET fiscal_year_start_month = ?', bind: [fyMonth] });
            for (const e of entries.filter((x) => x.dr !== x.cr)) {
              postEntry(db, {
                date: day(e.day),
                sourceType: 'journal',
                lines: [
                  { accountId: ids[e.dr]!, debit: e.cents, credit: 0 },
                  { accountId: ids[e.cr]!, debit: 0, credit: e.cents },
                ],
              });
            }
            const asOf = day(asOfDay);
            const bs = balanceSheet(db, { kind: 'bs', to: asOf });
            expect(amount(bs, 'Total Assets')).toBe(amount(bs, 'Total Liabilities and Equity'));
            expect(bs.notes).toEqual([]);
            const fyStart = fiscalYearStart(asOf, fyMonth);
            const pl = profitAndLoss(db, { kind: 'pl', from: fyStart, to: asOf });
            expect(amount(bs, 'Net Income')).toBe(amount(pl, 'Net Income'));
          } finally {
            db.exec('ROLLBACK TO prop');
            db.exec('RELEASE prop');
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('trial balance report (RP-4)', () => {
  it('lists debits and credits with equal totals, and drills to the right period', async () => {
    const db = await newLedgerDb();
    post(db, '2026-01-10', 'Checking', 'Services', 700_00);
    post(db, '2026-01-11', 'Meals', 'Checking', 25_00);
    const r = trialBalanceReport(db, { kind: 'tb', to: '2026-06-30' });
    expect(r.rows.at(-1)!.cells).toEqual(['Total', 700_00, 700_00]);
    expect(row(r, 'Services')!.drill).toMatchObject({ from: '2026-01-01', to: '2026-06-30' });
    expect(row(r, 'Checking')!.drill).toMatchObject({ from: null });
  });
});

describe('general ledger detail (RP-4, RP-5)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newLedgerDb();
    post(db, '2025-12-15', 'Checking', "Owner's Investment", 1_000_00);
    post(db, '2026-01-05', 'Meals', 'Checking', 40_00, { ref: 'C101', memo: 'Lunch' });
    postEntry(db, {
      date: '2026-01-06',
      sourceType: 'journal',
      memo: 'Supplies and fees',
      lines: [
        { accountId: accountId(db, 'Office Supplies and Software'), debit: 30_00, credit: 0 },
        { accountId: accountId(db, 'Bank Fees'), debit: 5_00, credit: 0 },
        { accountId: accountId(db, 'Checking'), debit: 0, credit: 35_00 },
      ],
    });
  });

  it('shows the balance before the period, each line with a running balance, and the total', () => {
    const r = generalLedger(db, {
      kind: 'gl',
      from: '2026-01-01',
      to: '2026-01-31',
      accountId: accountId(db, 'Checking'),
    });
    expect(r.rows.map((x) => x.cells)).toEqual([
      ['Checking', null, null, null, null, null, null, null, null],
      ['Beginning balance', null, null, null, null, null, null, null, 1_000_00],
      ['2026-01-05', '2', 'C101', null, 'Lunch', 'Meals', null, 40_00, 960_00],
      ['2026-01-06', '3', null, null, 'Supplies and fees', '-Split-', null, 35_00, 925_00],
      ['Total for Checking', null, null, null, null, null, 0, 75_00, 925_00],
    ]);
    expect(r.rows[2]!.drill).toEqual({ kind: 'entry', entryId: 2 });
  });

  it('covers every account with activity when none is chosen, credit-normal balances positive', () => {
    const r = generalLedger(db, { kind: 'gl', from: '2026-01-01', to: '2026-01-31' });
    const sections = r.rows.filter((x) => x.kind === 'section').map((x) => x.cells[0]);
    expect(sections).toEqual([
      'Checking',
      "Owner's Investment",
      'Bank Fees',
      'Meals',
      'Office Supplies and Software',
    ]);
    const owner = r.rows.find((x) => x.cells[0] === "Total for Owner's Investment")!;
    expect(owner.cells[8]).toBe(1_000_00);
  });

  it('starts income and expense accounts at zero each fiscal year', () => {
    post(db, '2025-11-01', 'Meals', 'Checking', 99_00);
    const r = generalLedger(db, {
      kind: 'gl',
      from: '2026-01-01',
      to: '2026-01-31',
      accountId: accountId(db, 'Meals'),
    });
    expect(r.rows[1]!.cells.at(-1)).toBe(0);
    const mid = generalLedger(db, {
      kind: 'gl',
      from: '2026-01-06',
      to: '2026-01-31',
      accountId: accountId(db, 'Meals'),
    });
    expect(mid.rows[1]!.cells.at(-1)).toBe(40_00);
  });

  it('says so when it stops at the line limit', () => {
    const r = generalLedger(db, { kind: 'gl', from: null, to: '2026-12-31' }, 3);
    expect(r.notes[0]).toMatch(/Only the first 3 lines/);
  });
});

describe('runReport', () => {
  it('checks dates', async () => {
    const db = await newLedgerDb();
    expect(() => runReport(db, { kind: 'pl', from: '2026-02-01', to: '2026-01-01' })).toThrow(
      /after the end date/,
    );
    expect(() => runReport(db, { kind: 'bs', to: '2026-02-30' })).toThrow(/valid dates/);
    expect(runReport(db, { kind: 'bs', to: '2026-02-28' }).title).toBe('Balance Sheet');
  });
});
