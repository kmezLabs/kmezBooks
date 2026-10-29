// Bill payments (AP-3, GL-8). A payment comes out of a bank or credit card
// account and may pay several of one vendor's bills, fully or in part: one
// check or transfer, so one entry, which bank review then matches to the
// statement line. It posts through the one posting path: the paid-from
// account is credited, and each bill's part is spread over that bill's lines
// by allocateProRata(), so expenses land in the lines' own accounts, to the
// cent. Voiding the payment (or its entry, in the journal) leaves the bills
// owed again.

import { allocateProRata } from '../../ledger/allocate';
import { postEntry, voidEntry, type PostOptions } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import type { Cents } from '../../shared/money';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';

/** source_type of a bill payment's entry; source_id is the payment's id. */
export const BILL_PAYMENT_SOURCE = 'bill_payment';

import { PAID_FROM } from './billRules';

export interface BillPaymentInput {
  vendorId: string;
  date: string;
  /** A bank, cash or credit card account */
  accountId: string;
  method: string | null;
  /** The check number, or another reference */
  ref: string | null;
  memo: string | null;
  /** How much goes to each bill */
  applications: { billId: string; amount: Cents }[];
}

export interface BillPayment {
  id: string;
  vendorId: string;
  vendor: string;
  date: string;
  accountId: string;
  amount: Cents;
  method: string | null;
  ref: string | null;
  memo: string | null;
  entryId: number | null;
  status: 'draft' | 'posted' | 'void';
  applications: { billId: string; number: string | null; amount: Cents }[];
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * The entry's expense lines: each bill's part spread over its lines by
 * allocateProRata(), then summed per account. Debit-positive.
 */
export function expensesByAccount(
  db: Database,
  applications: { billId: string; amount: Cents }[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const a of applications) {
    const lines = db.selectObjects(
      'SELECT amount, account_id FROM bill_line WHERE bill_id = ? ORDER BY line_no',
      [a.billId],
    );
    const parts = allocateProRata(
      a.amount,
      lines.map((l) => Number(l.amount)),
    );
    lines.forEach((l, i) => {
      const account = String(l.account_id);
      out.set(account, (out.get(account) ?? 0n) + BigInt(parts[i]!));
    });
  }
  return out;
}

/** Record a payment and post its expenses. Returns the payment and its entry. */
export function payBills(
  db: Database,
  input: BillPaymentInput,
  opts: PostOptions = {},
): { paymentId: string; entryId: number } {
  const applications = input.applications.filter((a) => a.amount !== 0);
  if (applications.length === 0) throw new LedgerRuleError('Choose a bill and the amount paid.');
  for (const a of applications) {
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) {
      throw new LedgerRuleError('Each amount paid must be above zero.');
    }
  }
  const from = db.selectValue('SELECT detail_type FROM account WHERE id = ?', [input.accountId]);
  if (from === undefined || !PAID_FROM.includes(String(from))) {
    throw new LedgerRuleError('Choose the bank or card account the money came from.');
  }
  const total = applications.reduce((s, a) => s + BigInt(a.amount), 0n);

  return inSavepoint(db, 'pay_bills', () => {
    const paymentId = crypto.randomUUID();
    db.exec({
      sql: `INSERT INTO bill_payment (id, company_id, vendor_id, date, account_id, amount, method, ref, memo)
            VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        paymentId,
        input.vendorId,
        input.date,
        input.accountId,
        Number(total),
        input.method?.trim() || null,
        input.ref?.trim() || null,
        input.memo?.trim() || null,
      ],
    });
    for (const a of applications) {
      db.exec({
        sql: `INSERT INTO bill_payment_application (payment_id, bill_id, company_id, amount)
              VALUES (?, ?, (SELECT id FROM company), ?)`,
        bind: [paymentId, a.billId, a.amount],
      });
    }
    const expenses = [...expensesByAccount(db, applications)].filter(([, v]) => v !== 0n);
    const numbers = applications
      .map((a) => db.selectValue('SELECT number FROM bill WHERE id = ?', [a.billId]))
      .filter((n) => n !== null && n !== undefined)
      .map(String);
    const vendor = db.selectValue('SELECT name FROM payee WHERE id = ?', [input.vendorId]);
    const memo =
      input.memo?.trim() ||
      (numbers.length
        ? `Payment for bill${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}`
        : `Payment for ${applications.length === 1 ? 'a bill' : `${applications.length} bills`}`);
    const entryId = postEntry(
      db,
      {
        date: input.date,
        ref: input.ref,
        name: vendor === undefined ? null : String(vendor),
        memo,
        sourceType: BILL_PAYMENT_SOURCE,
        sourceId: paymentId,
        lines: [
          ...expenses.map(([accountId, v]) => ({
            accountId,
            debit: v > 0n ? Number(v) : 0,
            credit: v < 0n ? Number(-v) : 0,
          })),
          { accountId: input.accountId, debit: 0, credit: Number(total) },
        ],
      },
      opts,
    );
    db.exec({
      sql: `UPDATE bill_payment SET entry_id = ?, status = 'posted' WHERE id = ?`,
      bind: [entryId, paymentId],
    });
    return { paymentId, entryId };
  });
}

/** Void a payment: its entry is voided, and the bills are owed again. Returns the entry. */
export function voidBillPayment(
  db: Database,
  id: string,
  reason: string | null,
  opts: PostOptions = {},
): number {
  const r = db.selectObjects('SELECT status, entry_id FROM bill_payment WHERE id = ?', [id])[0];
  if (!r) throw new LedgerRuleError('That payment no longer exists.');
  if (r.status !== 'posted') throw new LedgerRuleError('This payment is already void.');
  voidEntry(db, Number(r.entry_id), reason ?? 'Bill payment voided', opts);
  return Number(r.entry_id);
}

/** Payments, newest first: a vendor's, or those applied to a bill. */
export function listBillPayments(
  db: Database,
  q: { vendorId?: string | null; billId?: string | null } = {},
): BillPayment[] {
  const where: string[] = [];
  const bind: string[] = [];
  if (q.vendorId) {
    where.push('p.vendor_id = ?');
    bind.push(q.vendorId);
  }
  if (q.billId) {
    where.push(
      'EXISTS (SELECT 1 FROM bill_payment_application a WHERE a.payment_id = p.id AND a.bill_id = ?)',
    );
    bind.push(q.billId);
  }
  return db
    .selectObjects(
      `SELECT p.*, v.name AS vendor FROM bill_payment p JOIN payee v ON v.id = p.vendor_id
       WHERE p.status <> 'draft' ${where.length ? `AND ${where.join(' AND ')}` : ''}
       ORDER BY p.date DESC, p.created_at DESC`,
      bind.length ? bind : undefined,
    )
    .map((r) => ({
      id: String(r.id),
      vendorId: String(r.vendor_id),
      vendor: String(r.vendor),
      date: String(r.date),
      accountId: String(r.account_id),
      amount: Number(r.amount),
      method: text(r.method),
      ref: text(r.ref),
      memo: text(r.memo),
      entryId: r.entry_id === null ? null : Number(r.entry_id),
      status: r.status as BillPayment['status'],
      applications: db
        .selectObjects(
          `SELECT a.bill_id, b.number, a.amount FROM bill_payment_application a JOIN bill b ON b.id = a.bill_id
           WHERE a.payment_id = ? ORDER BY b.due_date, b.date`,
          [String(r.id)],
        )
        .map((a) => ({
          billId: String(a.bill_id),
          number: text(a.number),
          amount: Number(a.amount),
        })),
    }));
}
