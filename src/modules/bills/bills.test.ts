import { beforeEach, describe, expect, it } from 'vitest';
import { accountId, newLedgerDb } from '../../../db/tests/ledgerTestDb';
import { trialBalance } from '../../ledger/balances';
import { blankPayee, createPayee, getPayee, mergePayee } from '../../ledger/payees';
import type { Database } from '../../worker/sqlite';
import {
  billsDue,
  billState,
  createBill,
  deleteBill,
  getBill,
  listBills,
  updateBill,
  voidBill,
  type BillLineInput,
} from './bills';
import { listBillPayments, payBills, voidBillPayment } from './billPayments';

let db: Database;
let power: string;
beforeEach(async () => {
  db = await newLedgerDb();
  power = createPayee(db, { ...blankPayee('Georgia Power'), termsDays: 15 });
});

const line = (amount: number, account = 'Utilities'): BillLineInput => ({
  accountId: accountId(db, account),
  description: null,
  amount,
});
const bill = (lines: BillLineInput[], date = '2026-01-05', extra = {}) =>
  createBill(db, {
    vendorId: power,
    number: null,
    date,
    dueDate: null,
    termsDays: 15,
    memo: null,
    lines,
    ...extra,
  });
const pay = (
  applications: { billId: string; amount: number }[],
  date = '2026-01-20',
  account = 'Checking',
) =>
  payBills(db, {
    vendorId: power,
    date,
    accountId: accountId(db, account),
    method: 'Check',
    ref: '1001',
    memo: null,
    applications,
  });
/** Debits minus credits on an account, all dates. */
const balance = (name: string) => {
  const r = trialBalance(db, '2026-12-31').rows.find((x) => x.accountId === accountId(db, name));
  return r ? r.debit - r.credit : 0;
};

describe('bills (AP-2, AP-4, AP-5)', () => {
  it('dates a bill due by the terms, marks the vendor, and posts nothing', () => {
    const id = bill([line(120_00)]);
    expect(getBill(db, id, '2026-01-10')).toMatchObject({
      dueDate: '2026-01-20',
      total: 120_00,
      owed: 120_00,
      state: 'open',
      vendor: 'Georgia Power',
    });
    expect(getPayee(db, power).isVendor).toBe(true);
    expect(trialBalance(db, '2026-12-31').rows).toEqual([]);
    // No terms: due on its date
    const b = bill([line(10_00)], '2026-02-01', { termsDays: null });
    expect(getBill(db, b, '2026-02-01').dueDate).toBe('2026-02-01');
  });

  it('derives partly paid, paid, overdue and void (AP-4)', () => {
    const base = { status: 'open' as const, dueDate: '2026-01-20', total: 100_00 };
    expect(billState({ ...base, paid: 0 }, '2026-01-20')).toBe('open');
    expect(billState({ ...base, paid: 40_00 }, '2026-01-20')).toBe('partial');
    expect(billState({ ...base, paid: 40_00 }, '2026-01-21')).toBe('overdue');
    expect(billState({ ...base, paid: 100_00 }, '2026-03-01')).toBe('paid');
    expect(billState({ ...base, status: 'void', paid: 0 }, '2026-03-01')).toBe('void');
  });

  it('lists bills due by due date, oldest first, with what is overdue (AP-5)', () => {
    const late = bill([line(30_00)], '2026-01-01');
    const soon = bill([line(20_00)], '2026-01-15'); // due Jan 30, within the week
    const later = bill([line(10_00)], '2026-03-01');
    const paid = bill([line(5_00)], '2025-12-01');
    pay([{ billId: paid, amount: 5_00 }]);
    expect(listBills(db, { openOnly: true }, '2026-01-25').map((b) => b.id)).toEqual([
      late,
      soon,
      later,
    ]);
    expect(billsDue(db, '2026-01-25')).toEqual({ owed: 60_00, overdue: 30_00, dueSoon: 20_00 });
  });

  it('refuses lines to money, A/R or A/P accounts, and totals of zero', () => {
    expect(() => bill([line(10_00, 'Checking')])).toThrow(/not a bank, card/);
    expect(() => bill([line(10_00, 'Credit Card')])).toThrow(/not a bank, card/);
    expect(() => bill([line(10_00), line(-10_00)])).toThrow(/total above zero/);
    expect(() => bill([])).toThrow(/at least one line/);
    // An equipment purchase on a bill is fine
    expect(() => bill([line(900_00, 'Furniture and Equipment')])).not.toThrow();
  });

  it('a paid bill keeps its lines, but its number, dates and memo can change', () => {
    const id = bill([line(100_00)]);
    pay([{ billId: id, amount: 10_00 }]);
    updateBill(
      db,
      id,
      {
        vendorId: power,
        number: 'INV-77',
        date: '2026-01-06',
        dueDate: null,
        termsDays: 30,
        memo: 'January',
        lines: [line(999_00)],
      },
      '2026-01-20',
    );
    expect(getBill(db, id, '2026-01-20')).toMatchObject({
      number: 'INV-77',
      dueDate: '2026-02-05',
      memo: 'January',
      total: 100_00,
    });
  });

  it('voids or deletes an unpaid bill', () => {
    const a = bill([line(10_00)]);
    const b = bill([line(20_00)]);
    voidBill(db, a);
    expect(getBill(db, a, '2026-01-10')).toMatchObject({ state: 'void', owed: 0 });
    deleteBill(db, b);
    expect(() => getBill(db, b, '2026-01-10')).toThrow(/no longer exists/);
  });
});

describe('bill payments (AP-3, GL-8)', () => {
  it('posts each payment’s expenses over the bill lines, pro rata to the cent', () => {
    // Two-thirds utilities, one-third phone, with a credit line
    const id = bill([
      line(600_00),
      line(300_00, 'Office Supplies and Software'),
      line(-100_00, 'Other Expenses'),
    ]);
    pay([{ billId: id, amount: 300_00 }]);
    expect(balance('Utilities')).toBe(225_00);
    expect(balance('Office Supplies and Software')).toBe(112_50);
    expect(balance('Other Expenses')).toBe(-37_50);
    expect(balance('Checking')).toBe(-300_00);
    pay([{ billId: id, amount: 500_00 }], '2026-02-03');
    expect([
      balance('Utilities'),
      balance('Office Supplies and Software'),
      balance('Other Expenses'),
    ]).toEqual([600_00, 300_00, -100_00]);
    expect(getBill(db, id, '2026-02-03')).toMatchObject({ state: 'paid', owed: 0 });
    // Cash basis: nothing in A/P
    expect(
      trialBalance(db, '2026-12-31').rows.find((r) => r.account.includes('Payable')),
    ).toBeUndefined();
  });

  it('pays several bills with one check: one entry for the bank', () => {
    const a = bill([line(100_00)]);
    const b = bill([line(50_00, 'Office Supplies and Software')]);
    const { entryId, paymentId } = pay([
      { billId: a, amount: 100_00 },
      { billId: b, amount: 20_00 },
    ]);
    const bank = db.selectObjects(
      `SELECT credit FROM journal_line WHERE entry_id = ? AND account_id = ?`,
      [entryId, accountId(db, 'Checking')],
    );
    expect(bank).toEqual([{ credit: 120_00 }]);
    const entry = db.selectObjects(
      `SELECT ref, name, source_type FROM journal_entry WHERE id = ?`,
      [entryId],
    )[0];
    expect(entry).toEqual({ ref: '1001', name: 'Georgia Power', source_type: 'bill_payment' });
    expect(listBillPayments(db, { billId: b })[0]).toMatchObject({ id: paymentId, amount: 120_00 });
    expect(getBill(db, b, '2026-01-20')).toMatchObject({ state: 'partial', owed: 30_00 });
  });

  it('pays from a credit card, which then owes it', () => {
    const id = bill([line(80_00)]);
    pay([{ billId: id, amount: 80_00 }], '2026-01-20', 'Credit Card');
    expect(balance('Credit Card')).toBe(-80_00);
    expect(balance('Utilities')).toBe(80_00);
  });

  it('refuses overpaying, nothing to pay, and an account that isn’t a bank or card', () => {
    const id = bill([line(100_00)]);
    expect(() => pay([{ billId: id, amount: 100_01 }])).toThrow(/can't exceed/);
    expect(() => pay([])).toThrow(/Choose a bill/);
    expect(() => pay([{ billId: id, amount: -5 }])).toThrow(/above zero/);
    expect(() => pay([{ billId: id, amount: 5_00 }], '2026-01-20', 'Utilities')).toThrow(
      /bank or card account/,
    );
    // Nothing was left behind by the refused payments
    expect(db.selectValue('SELECT count(*) FROM bill_payment')).toBe(0);
  });

  it('voids a payment with its entry; the bill is owed again and can be changed', () => {
    const id = bill([line(100_00)]);
    const { paymentId } = pay([{ billId: id, amount: 100_00 }]);
    voidBillPayment(db, paymentId, null);
    expect(balance('Utilities')).toBe(0);
    expect(getBill(db, id, '2026-01-20')).toMatchObject({ owed: 100_00, hasPayments: false });
    expect(() => voidBillPayment(db, paymentId, null)).toThrow(/already void/);
    voidBill(db, id);
  });

  it('merging vendors moves their bills and payments', () => {
    const id = bill([line(100_00)]);
    pay([{ billId: id, amount: 40_00 }]);
    const into = createPayee(db, { ...blankPayee('GA Power'), isVendor: true });
    mergePayee(db, power, into);
    expect(getBill(db, id, '2026-01-20').vendor).toBe('GA Power');
    expect(listBillPayments(db, { vendorId: into })).toHaveLength(1);
  });
});
