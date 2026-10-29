import { describe, expect, it } from 'vitest';
import { blankPayee, createPayee } from '../../src/ledger/payees';
import { voidEntry } from '../../src/ledger/postEntry';
import { createBill, type BillInput } from '../../src/modules/bills/bills';
import { payBills } from '../../src/modules/bills/billPayments';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post } from './ledgerTestDb';

const raise =
  (db: Database, sql: string, bind: (string | number | null)[] = []) =>
  () =>
    db.exec({ sql, bind });

async function setup() {
  const db = await newLedgerDb();
  const vendor = createPayee(db, { ...blankPayee('Georgia Power'), isVendor: true });
  const other = createPayee(db, { ...blankPayee('Comcast'), isVendor: true });
  const bill = (cents = 100_00, who = vendor) =>
    createBill(db, {
      vendorId: who,
      number: 'B-1',
      date: '2026-01-05',
      dueDate: null,
      termsDays: 30,
      memo: null,
      lines: [{ accountId: accountId(db, 'Utilities'), description: null, amount: cents }],
    } satisfies BillInput);
  const pay = (billId: string, amount: number, who = vendor) =>
    payBills(db, {
      vendorId: who,
      date: '2026-01-20',
      accountId: accountId(db, 'Checking'),
      method: 'Check',
      ref: '1001',
      memo: null,
      applications: [{ billId, amount }],
    });
  return { db, vendor, other, bill, pay };
}

describe('bills and bill payments in the schema (AP-2 to AP-4)', () => {
  it('never lets payments exceed what a bill still owes', async () => {
    const { db, bill, pay } = await setup();
    const b = bill();
    pay(b, 60_00);
    expect(() => pay(b, 50_00)).toThrow(/can't exceed what is still owed/);
    pay(b, 40_00);
    expect(Number(db.selectValue(`SELECT paid FROM bill_paid WHERE bill_id = ?`, [b]))).toBe(
      100_00,
    );
  });

  it('applies payments only to the vendor’s own bills that aren’t void', async () => {
    const { db, bill, pay, other } = await setup();
    const b = bill();
    expect(() => pay(b, 10_00, other)).toThrow(/its vendor's bills/);
    db.exec({ sql: `UPDATE bill SET status = 'void', voided_at = 'now' WHERE id = ?`, bind: [b] });
    expect(() => pay(b, 10_00)).toThrow(/isn't void/);
  });

  it('fixes a paid bill’s lines and vendor; voiding the payment frees them', async () => {
    const { db, bill, pay, other } = await setup();
    const b = bill();
    const { entryId } = pay(b, 10_00);
    expect(raise(db, `UPDATE bill_line SET amount = 5000 WHERE bill_id = ?`, [b])).toThrow(
      /AP-2: this bill has payments/,
    );
    expect(raise(db, `DELETE FROM bill_line WHERE bill_id = ?`, [b])).toThrow(/void them/);
    expect(raise(db, `UPDATE bill SET vendor_id = ? WHERE id = ?`, [other, b])).toThrow(
      /AP-4: this bill has payments/,
    );
    expect(
      raise(db, `UPDATE bill SET status = 'void', voided_at = 'now' WHERE id = ?`, [b]),
    ).toThrow(/void them first/);
    expect(raise(db, `DELETE FROM bill WHERE id = ?`, [b])).toThrow(/void it instead/);
    // Voiding the entry in the journal voids the payment, and the bill is open again
    voidEntry(db, entryId, null);
    expect(db.selectValue(`SELECT status FROM bill_payment`)).toBe('void');
    expect(raise(db, `UPDATE bill_line SET amount = 5000 WHERE bill_id = ?`, [b])).not.toThrow();
  });

  it('keeps a void bill as it is', async () => {
    const { db, bill } = await setup();
    const b = bill();
    db.exec({ sql: `UPDATE bill SET status = 'void', voided_at = 'now' WHERE id = ?`, bind: [b] });
    expect(raise(db, `UPDATE bill SET memo = 'x' WHERE id = ?`, [b])).toThrow(/AP-2: a void bill/);
    expect(raise(db, `UPDATE bill_line SET amount = 1 WHERE bill_id = ?`, [b])).toThrow(
      /a void bill/,
    );
  });

  it('keeps a posted payment and its applications as they were', async () => {
    const { db, bill, pay } = await setup();
    const { paymentId } = pay(bill(), 10_00);
    expect(raise(db, `UPDATE bill_payment SET amount = 500 WHERE id = ?`, [paymentId])).toThrow(
      /AP-3/,
    );
    expect(raise(db, `UPDATE bill_payment_application SET amount = 500`)).toThrow(/AP-3/);
    expect(raise(db, `DELETE FROM bill_payment_application`)).toThrow(/AP-3/);
    expect(raise(db, `DELETE FROM bill_payment`)).toThrow(/AP-3/);
    expect(raise(db, `UPDATE bill_payment SET status = 'void' WHERE id = ?`, [paymentId])).toThrow(
      /only with its entry/,
    );
  });

  it('posts a payment only with its own entry, and never changes that entry in place', async () => {
    const { db, bill, vendor, pay } = await setup();
    const b = bill();
    db.exec({
      sql: `INSERT INTO bill_payment (id, company_id, vendor_id, date, account_id, amount)
            VALUES ('p1', (SELECT id FROM company), ?, '2026-01-20', ?, 1000)`,
      bind: [vendor, accountId(db, 'Checking')],
    });
    db.exec({
      sql: `INSERT INTO bill_payment_application (payment_id, bill_id, company_id, amount)
            VALUES ('p1', ?, (SELECT id FROM company), 1000)`,
      bind: [b],
    });
    expect(raise(db, `UPDATE bill_payment SET status = 'posted' WHERE id = 'p1'`)).toThrow(
      /its own posted entry/,
    );
    const unrelated = post(db, '2026-01-20', 'Utilities', 'Checking', 10_00);
    expect(
      raise(db, `UPDATE bill_payment SET status = 'posted', entry_id = ? WHERE id = 'p1'`, [
        unrelated,
      ]),
    ).toThrow(/its own posted entry/);
    db.exec('UPDATE company SET posted_edits = 1');
    const { entryId } = pay(bill(), 10_00);
    expect(raise(db, `UPDATE journal_entry SET status = 'draft' WHERE id = ?`, [entryId])).toThrow(
      /AP-3: this entry is a bill payment/,
    );
  });

  it('keeps payees that bills and their payments name', async () => {
    const { db, bill, vendor } = await setup();
    bill();
    expect(raise(db, `DELETE FROM payee WHERE id = ?`, [vendor])).toThrow(/GL-11/);
  });
});
