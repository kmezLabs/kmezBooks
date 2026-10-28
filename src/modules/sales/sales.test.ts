import { beforeEach, describe, expect, it } from 'vitest';
import { accountId, newLedgerDb } from '../../../db/tests/ledgerTestDb';
import { trialBalance } from '../../ledger/balances';
import { blankPayee, createPayee, getPayee, mergePayee } from '../../ledger/payees';
import { correctEntry } from '../../ledger/postEntry';
import type { Database } from '../../worker/sqlite';
import {
  addDays,
  convertEstimate,
  createDoc,
  customerBalances,
  getDoc,
  lineAmount,
  listDocs,
  nextNumber,
  stateOf,
  updateDoc,
  voidDoc,
  type DocInput,
  type DocLineInput,
} from './documents';
import { createItem, listItems, updateItem } from './items';
import { incomeByAccount, listPayments, receivePayment, voidPayment } from './payments';

let db: Database;
let smith: string;
beforeEach(async () => {
  db = await newLedgerDb();
  smith = createPayee(db, { ...blankPayee('Smith Family'), termsDays: 15 });
});

const line = (
  amount: number,
  account = 'Services',
  extra: Partial<DocLineInput> = {},
): DocLineInput => ({
  itemId: null,
  description: null,
  quantity: null,
  rate: null,
  amount,
  incomeAccountId: accountId(db, account),
  ...extra,
});

const invoice = (lines: DocLineInput[], extra: Partial<DocInput> = {}) =>
  createDoc(db, {
    kind: 'invoice',
    number: nextNumber(db, 'invoice'),
    customerId: smith,
    date: '2026-01-05',
    dueDate: null,
    termsDays: 15,
    memo: null,
    lines,
    ...extra,
  });

const pay = (applications: { docId: string; amount: number }[], date = '2026-01-20') =>
  receivePayment(db, {
    customerId: smith,
    date,
    depositAccountId: accountId(db, 'Checking'),
    method: 'check',
    ref: '501',
    memo: null,
    applications,
  });

/** Credit minus debit in an account, as of the end of the year */
const income = (name: string) => {
  const r = trialBalance(db, '2026-12-31').rows.find((x) => x.accountId === accountId(db, name));
  return r ? r.credit - r.debit : 0;
};

describe('products and services (AR-2)', () => {
  it('keeps items with a rate and an income account, names unique', () => {
    const id = createItem(db, {
      name: 'Tuition',
      description: 'Monthly tuition',
      rate: 950_00,
      incomeAccountId: accountId(db, 'Services'),
      active: true,
    });
    expect(listItems(db)).toMatchObject([{ id, name: 'Tuition', rate: 950_00 }]);
    expect(() =>
      createItem(db, {
        name: 'tuition',
        description: null,
        rate: null,
        incomeAccountId: accountId(db, 'Services'),
        active: true,
      }),
    ).toThrow('already');
    expect(() =>
      createItem(db, {
        name: 'Bad',
        description: null,
        rate: null,
        incomeAccountId: accountId(db, 'Checking'),
        active: true,
      }),
    ).toThrow('income account');
    updateItem(db, id, { ...listItems(db)[0]!, active: false });
    expect(listItems(db)).toEqual([]);
    expect(listItems(db, true)).toHaveLength(1);
  });
});

describe('estimates and invoices (AR-3, AR-4, AR-5)', () => {
  it('works out line amounts from quantity and rate, to the cent', () => {
    expect(lineAmount(2500, 950_00)).toBe(2375_00); // 2.5 × 950.00
    expect(lineAmount(333, 1_00)).toBe(33); // 0.333 × 1.00 = 0.333
    expect(lineAmount(1005, 1_00)).toBe(1_01); // 1.005 rounds up
    expect(lineAmount(-1000, 25_00)).toBe(-25_00);
  });

  it('numbers invoices from 1001, dates them due by the customer’s terms, and marks the customer', () => {
    const a = invoice([line(100_00)]);
    const b = invoice([line(50_00)], { dueDate: '2026-03-01' });
    expect(getDoc(db, a, '2026-01-05')).toMatchObject({
      number: '1001',
      dueDate: addDays('2026-01-05', 15),
      total: 100_00,
      owed: 100_00,
      state: 'draft',
    });
    expect(getDoc(db, b, '2026-01-05')).toMatchObject({ number: '1002', dueDate: '2026-03-01' });
    expect(getPayee(db, smith).isCustomer).toBe(true);
    expect(() => invoice([line(-10_00)])).toThrow('total above zero');
  });

  it('derives paid, partly paid and overdue from payments and the due date', () => {
    const d = {
      kind: 'invoice' as const,
      status: 'sent' as const,
      dueDate: '2026-01-20',
      total: 100_00,
    };
    expect(stateOf({ ...d, paid: 0 }, '2026-01-10')).toBe('sent');
    expect(stateOf({ ...d, paid: 40_00 }, '2026-01-10')).toBe('partial');
    expect(stateOf({ ...d, paid: 40_00 }, '2026-01-21')).toBe('overdue');
    expect(stateOf({ ...d, paid: 100_00 }, '2026-02-01')).toBe('paid');
    expect(stateOf({ ...d, status: 'void', paid: 0 }, '2026-02-01')).toBe('void');
  });

  it('turns an estimate into an invoice once', () => {
    const est = createDoc(db, {
      kind: 'estimate',
      number: nextNumber(db, 'estimate'),
      customerId: smith,
      date: '2026-01-02',
      dueDate: null,
      termsDays: null,
      memo: 'Summer camp',
      lines: [line(300_00, 'Services', { description: 'Camp week' })],
    });
    const inv = convertEstimate(db, est, '2026-01-10', '2026-01-10');
    expect(getDoc(db, est, '2026-01-10')).toMatchObject({ status: 'accepted', convertedTo: inv });
    expect(getDoc(db, inv, '2026-01-10')).toMatchObject({
      kind: 'invoice',
      total: 300_00,
      memo: 'Summer camp',
      dueDate: '2026-01-25',
    });
    expect(() => convertEstimate(db, est, '2026-01-10', '2026-01-10')).toThrow(
      'already an invoice',
    );
  });
});

describe('customer payments (AR-7, GL-8)', () => {
  it('posts each payment’s income over the invoice lines, pro rata to the cent', () => {
    // 60% services, 40% sales, with a discount line
    const inv = invoice([line(600_00), line(400_00, 'Sales'), line(-100_00, 'Discounts Given')]);
    const { entryId } = pay([{ docId: inv, amount: 300_00 }]);
    expect(income('Services')).toBe(200_00);
    expect(income('Sales')).toBe(133_33);
    expect(income('Discounts Given')).toBe(-33_33);
    // The rest of it, on another day
    pay([{ docId: inv, amount: 600_00 }], '2026-02-03');
    expect([income('Services'), income('Sales'), income('Discounts Given')]).toEqual([
      600_00, 400_00, -100_00,
    ]);
    expect(getDoc(db, inv, '2026-02-03')).toMatchObject({ state: 'paid', owed: 0, paid: 900_00 });
    expect(entryId).toBeGreaterThan(0);
    // Cash basis: nothing in A/R, only the bank and income moved
    expect(
      trialBalance(db, '2026-12-31').rows.find((r) => r.account.includes('Receivable')),
    ).toBeUndefined();
  });

  it('pays several invoices in one payment, one entry for the deposit', () => {
    const a = invoice([line(100_00)]);
    const b = invoice([line(50_00, 'Sales')]);
    const { entryId } = pay([
      { docId: a, amount: 100_00 },
      { docId: b, amount: 20_00 },
    ]);
    const lines = db.selectObjects(
      `SELECT a.name, l.debit, l.credit FROM journal_line l JOIN account a ON a.id = l.account_id
       WHERE l.entry_id = ? ORDER BY l.line_no`,
      [entryId],
    );
    expect(lines).toEqual([
      { name: 'Checking', debit: 120_00, credit: 0 },
      { name: 'Services', debit: 0, credit: 100_00 },
      { name: 'Sales', debit: 0, credit: 20_00 },
    ]);
    expect(listPayments(db, { docId: b })).toMatchObject([
      { amount: 120_00, applications: [{ amount: 100_00 }, { amount: 20_00 }] },
    ]);
    expect(customerBalances(db, '2026-01-25')).toMatchObject([
      { customer: 'Smith Family', owed: 30_00, invoices: 1 },
    ]);
  });

  it('refuses overpaying, nothing to pay, and an account that isn’t a bank', () => {
    const a = invoice([line(100_00)]);
    expect(() => pay([{ docId: a, amount: 100_01 }])).toThrow("can't exceed");
    expect(() => pay([])).toThrow('Choose an invoice');
    expect(() =>
      receivePayment(db, {
        customerId: smith,
        date: '2026-01-20',
        depositAccountId: accountId(db, 'Services'),
        method: null,
        ref: null,
        memo: null,
        applications: [{ docId: a, amount: 10_00 }],
      }),
    ).toThrow('the money went into');
  });

  it('voids a payment with its entry; the invoice is owed again and can be changed', () => {
    const a = invoice([line(100_00)]);
    const { paymentId, entryId } = pay([{ docId: a, amount: 100_00 }]);
    expect(() => correctEntry(db, entryId, { date: '2026-01-21', lines: [] })).toThrow(
      'void the payment',
    );
    expect(() => voidDoc(db, a)).toThrow('void them first');
    voidPayment(db, paymentId, null);
    expect(income('Services')).toBe(0);
    expect(getDoc(db, a, '2026-01-21')).toMatchObject({ owed: 100_00, hasPayments: false });
    updateDoc(db, a, { ...getDoc(db, a, '2026-01-21'), lines: [line(80_00)] }, '2026-01-21');
    expect(getDoc(db, a, '2026-01-21').total).toBe(80_00);
    expect(() => voidPayment(db, paymentId, null)).toThrow('already void');
  });

  it('a paid invoice keeps its lines but its memo and dates can change', () => {
    const a = invoice([line(100_00)]);
    pay([{ docId: a, amount: 10_00 }]);
    updateDoc(
      db,
      a,
      { ...getDoc(db, a, '2026-01-21'), memo: 'Thank you', lines: [line(999_00)] },
      '2026-01-21',
    );
    expect(getDoc(db, a, '2026-01-21')).toMatchObject({ memo: 'Thank you', total: 100_00 });
  });

  it('merging customers moves their invoices and payments', () => {
    const dup = createPayee(db, blankPayee('Smith Fam.'));
    const a = invoice([line(100_00)], { customerId: dup });
    receivePayment(db, {
      customerId: dup,
      date: '2026-01-20',
      depositAccountId: accountId(db, 'Checking'),
      method: null,
      ref: null,
      memo: null,
      applications: [{ docId: a, amount: 10_00 }],
    });
    mergePayee(db, dup, smith);
    expect(getDoc(db, a, '2026-01-20').customerId).toBe(smith);
    expect(listPayments(db, { customerId: smith })).toHaveLength(1);
    expect(listDocs(db, { kind: 'invoice', customerId: smith }, '2026-01-20')).toHaveLength(1);
  });

  it('spreads a part payment exactly, even over awkward amounts', () => {
    const a = invoice([line(1_00), line(1_00, 'Sales'), line(1_00, 'Other Income')]);
    const parts = incomeByAccount(db, [{ docId: a, amount: 1_00 }]);
    expect([...parts.values()].reduce((s, v) => s + v, 0n)).toBe(100n);
  });
});
