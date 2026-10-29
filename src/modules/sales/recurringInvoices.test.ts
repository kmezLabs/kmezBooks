import { beforeEach, describe, expect, it } from 'vitest';
import { accountId, newLedgerDb } from '../../../db/tests/ledgerTestDb';
import { trialBalance } from '../../ledger/balances';
import { blankPayee, createPayee, deletePayee, mergePayee } from '../../ledger/payees';
import type { Database } from '../../worker/sqlite';
import { createDoc, deleteDoc, getDoc, listDocs, voidDoc } from './documents';
import {
  CATCH_UP_LIMIT,
  createDue,
  createNow,
  createRecurringInvoice,
  deleteRecurringInvoice,
  getRecurringInvoice,
  setRecurringInvoiceActive,
  skipNextInvoice,
  updateRecurringInvoice,
  type RecurringInvoiceInput,
} from './recurringInvoices';

let db: Database;
let smith: string;
beforeEach(async () => {
  db = await newLedgerDb();
  smith = createPayee(db, { ...blankPayee('Smith Family'), isCustomer: true });
});

/** Monthly tuition on the 1st, due in 15 days. */
const tuition = (extra: Partial<RecurringInvoiceInput> = {}): RecurringInvoiceInput => ({
  name: 'Tuition',
  customerId: smith,
  frequency: 'monthly',
  dayOfMonth: 1,
  startDate: '2026-01-01',
  endDate: null,
  termsDays: 15,
  memo: 'Thank you!',
  lines: [
    {
      itemId: null,
      description: 'Full day',
      quantity: 1000,
      rate: 950_00,
      amount: 950_00,
      incomeAccountId: accountId(db, 'Services'),
    },
    {
      itemId: null,
      description: 'Sibling discount',
      quantity: null,
      rate: null,
      amount: -50_00,
      incomeAccountId: accountId(db, 'Services'),
    },
  ],
  ...extra,
});

const invoices = () =>
  listDocs(db, { kind: 'invoice' }, '2026-12-31')
    .reverse()
    .map((d) => `${d.number} ${d.date} ${d.dueDate} ${d.status} ${d.total}`);

describe('recurring invoices (AR-9)', () => {
  it('makes a draft invoice for every date that has come, each once, and posts nothing', () => {
    const id = createRecurringInvoice(db, tuition());
    expect(getRecurringInvoice(db, id).nextDate).toBe('2026-01-01');
    const r = createDue(db, '2026-03-15');
    expect(r.created.map((c) => `${c.number} ${c.date} ${c.customer}`)).toEqual([
      '1001 2026-01-01 Smith Family',
      '1002 2026-02-01 Smith Family',
      '1003 2026-03-01 Smith Family',
    ]);
    expect(r.waiting).toEqual([]);
    expect(invoices()).toEqual([
      '1001 2026-01-01 2026-01-16 draft 90000',
      '1002 2026-02-01 2026-02-16 draft 90000',
      '1003 2026-03-01 2026-03-16 draft 90000',
    ]);
    const doc = getDoc(db, r.created[0]!.docId, '2026-03-15');
    expect(doc.memo).toBe('Thank you!');
    expect(doc.recurringId).toBe(id);
    expect(doc.lines.map((l) => l.description)).toEqual(['Full day', 'Sibling discount']);
    // Again the same day: nothing new
    expect(createDue(db, '2026-03-15').created).toEqual([]);
    expect(getRecurringInvoice(db, id).nextDate).toBe('2026-04-01');
    expect(getRecurringInvoice(db, id).lastMade).toBe('2026-03-01');
    // Cash basis: documents never post
    expect(trialBalance(db, '2026-12-31').rows).toEqual([]);
  });

  it('is due on receipt without terms, and stops at the end date', () => {
    createRecurringInvoice(db, tuition({ termsDays: null, endDate: '2026-02-15' }));
    createDue(db, '2026-06-30');
    expect(invoices()).toEqual([
      '1001 2026-01-01 2026-01-01 draft 90000',
      '1002 2026-02-01 2026-02-01 draft 90000',
    ]);
  });

  it('skips inactive templates and those with dates still to come', () => {
    const a = createRecurringInvoice(db, tuition());
    createRecurringInvoice(db, tuition({ name: 'Later', startDate: '2026-07-01' }));
    setRecurringInvoiceActive(db, a, false);
    expect(createDue(db, '2026-03-15').created).toEqual([]);
  });

  it('says so when more dates were due than one go makes', () => {
    createRecurringInvoice(db, tuition({ startDate: '2020-01-01' }));
    const r = createDue(db, '2026-03-15');
    expect(r.created).toHaveLength(CATCH_UP_LIMIT);
    expect(r.waiting[0]!.reason).toMatch(/more than 36 dates/);
  });

  it('waits, with the reason, when an invoice can’t be made', () => {
    const id = createRecurringInvoice(db, tuition());
    // An income account turned into another type since the template was saved
    db.exec(`UPDATE account SET type = 'expense' WHERE name = 'Services'`);
    const r = createDue(db, '2026-02-15');
    expect(r.created).toEqual([]);
    expect(r.waiting).toEqual([
      {
        recurringId: id,
        name: 'Tuition',
        date: '2026-01-01',
        reason: 'each line needs the income account it goes to',
      },
    ]);
    expect(getRecurringInvoice(db, id).nextDate).toBe('2026-01-01');
  });

  it('skips a date, makes the next early, and an edit keeps what was made and skipped', () => {
    const id = createRecurringInvoice(db, tuition());
    createDue(db, '2026-01-15');
    skipNextInvoice(db, id);
    expect(getRecurringInvoice(db, id).nextDate).toBe('2026-03-01');
    const early = createNow(db, id);
    expect(getDoc(db, early, '2026-01-15').date).toBe('2026-03-01');
    updateRecurringInvoice(db, id, tuition({ dayOfMonth: 15, memo: 'New message' }));
    // March was made already, so the new day carries on from April
    expect(getRecurringInvoice(db, id).nextDate).toBe('2026-04-15');
    // Invoices already made stay as they are
    expect(getDoc(db, early, '2026-01-15').memo).toBe('Thank you!');
  });

  it('a voided or deleted invoice isn’t made again; a template that made invoices stays', () => {
    const id = createRecurringInvoice(db, tuition());
    const r = createDue(db, '2026-02-15');
    voidDoc(db, r.created[0]!.docId);
    deleteDoc(db, r.created[1]!.docId);
    expect(createDue(db, '2026-02-15').created).toEqual([]);
    expect(
      db.selectValues('SELECT doc_id FROM recurring_invoice_run ORDER BY date').map(String),
    ).toEqual([r.created[0]!.docId, 'null']);
    expect(() => deleteRecurringInvoice(db, id)).toThrow(/make it inactive instead/);
    const unused = createRecurringInvoice(db, tuition({ name: 'Unused', startDate: '2027-01-01' }));
    deleteRecurringInvoice(db, unused);
  });

  it('refuses templates that wouldn’t make an invoice', () => {
    expect(() => createRecurringInvoice(db, tuition({ name: ' ' }))).toThrow(/name/);
    expect(() => createRecurringInvoice(db, tuition({ customerId: 'nobody' }))).toThrow(/customer/);
    expect(() => createRecurringInvoice(db, tuition({ lines: [] }))).toThrow(/at least one line/);
    expect(() => createRecurringInvoice(db, tuition({ endDate: '2025-12-31' }))).toThrow(
      /end date is before/,
    );
    expect(() =>
      createRecurringInvoice(db, {
        ...tuition(),
        lines: [{ ...tuition().lines[1]! }],
      }),
    ).toThrow(/total above zero/);
  });

  it('keeps its customer: delete refused, merge moves it (GL-11)', () => {
    const id = createRecurringInvoice(db, tuition());
    expect(() => deletePayee(db, smith)).toThrow(/merge it into another payee/);
    const other = createPayee(db, { ...blankPayee('Smiths'), isCustomer: true });
    mergePayee(db, smith, other);
    expect(getRecurringInvoice(db, id).customer).toBe('Smiths');
  });
});

describe('recurring invoice runs in the schema (AR-9)', () => {
  const run = (recurringId: string, date: string, docId: string | null) =>
    db.exec({
      sql: `INSERT INTO recurring_invoice_run (recurring_id, date, company_id, doc_id)
            VALUES (?, ?, (SELECT id FROM company), ?)`,
      bind: [recurringId, date, docId],
    });
  const invoice = (date: string, recurringId: string | null) =>
    createDoc(
      db,
      {
        kind: 'invoice',
        number: String(Math.floor(Math.random() * 1e9)),
        customerId: smith,
        date,
        dueDate: null,
        termsDays: null,
        memo: null,
        lines: tuition().lines,
      },
      recurringId,
    );

  it('records only the template’s own invoice for that date', () => {
    const id = createRecurringInvoice(db, tuition());
    expect(() => run(id, '2026-01-01', invoice('2026-01-01', null))).toThrow(
      /AR-9: a recurring run must record/,
    );
    expect(() => run(id, '2026-01-01', invoice('2026-01-02', id))).toThrow(/AR-9/);
    expect(() => run(id, '2026-01-01', null)).toThrow(/AR-9/);
    run(id, '2026-01-01', invoice('2026-01-01', id));
    // The same date twice
    expect(() => run(id, '2026-01-01', invoice('2026-01-01', id))).toThrow(/UNIQUE|PRIMARY/);
  });

  it('keeps runs as history', () => {
    const id = createRecurringInvoice(db, tuition());
    createDue(db, '2026-01-15');
    expect(() => db.exec(`UPDATE recurring_invoice_run SET date = '2026-01-02'`)).toThrow(
      /AR-9: recurring runs cannot be changed/,
    );
    expect(() => db.exec(`DELETE FROM recurring_invoice_run`)).toThrow(
      /AR-9: recurring runs cannot be deleted/,
    );
    expect(() =>
      db.exec({ sql: `DELETE FROM recurring_invoice WHERE id = ?`, bind: [id] }),
    ).toThrow(/AR-9: this recurring invoice has made invoices/);
  });
});
