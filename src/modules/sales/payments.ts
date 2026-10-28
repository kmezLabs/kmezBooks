// Customer payments (AR-7, GL-8). A payment goes straight into a bank (or
// cash) account and may pay several invoices, fully or in part. It posts one
// entry through the one posting path: the deposit account is debited, and each
// invoice's part is spread over that invoice's lines by allocateProRata(), so
// income lands in the lines' own accounts, to the cent. Voiding the payment
// (or its entry, in the journal) leaves the invoices owed again.

import { allocateProRata } from '../../ledger/allocate';
import { postEntry, voidEntry, type PostOptions } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import type { Cents } from '../../shared/money';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';

/** source_type of a payment's entry; source_id is the payment's id. */
export const PAYMENT_SOURCE = 'invoice_payment';

export interface PaymentInput {
  customerId: string;
  date: string;
  depositAccountId: string;
  method: string | null;
  ref: string | null;
  memo: string | null;
  /** How much goes to each invoice */
  applications: { docId: string; amount: Cents }[];
}

export interface Payment {
  id: string;
  customerId: string;
  customer: string;
  date: string;
  depositAccountId: string;
  amount: Cents;
  method: string | null;
  ref: string | null;
  memo: string | null;
  entryId: number | null;
  status: 'draft' | 'posted' | 'void';
  applications: { docId: string; number: string; amount: Cents }[];
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

/**
 * The entry's income lines: each invoice's part spread over its lines by
 * allocateProRata(), then summed per income account. Credit-positive.
 */
export function incomeByAccount(
  db: Database,
  applications: { docId: string; amount: Cents }[],
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const a of applications) {
    const lines = db.selectObjects(
      'SELECT amount, income_account_id FROM sales_doc_line WHERE doc_id = ? ORDER BY line_no',
      [a.docId],
    );
    const parts = allocateProRata(
      a.amount,
      lines.map((l) => Number(l.amount)),
    );
    lines.forEach((l, i) => {
      const account = String(l.income_account_id);
      out.set(account, (out.get(account) ?? 0n) + BigInt(parts[i]!));
    });
  }
  return out;
}

/** Record a payment and post its income. Returns the payment and its entry. */
export function receivePayment(
  db: Database,
  input: PaymentInput,
  opts: PostOptions = {},
): { paymentId: string; entryId: number } {
  const applications = input.applications.filter((a) => a.amount !== 0);
  if (applications.length === 0)
    throw new LedgerRuleError('Choose an invoice and the amount paid.');
  for (const a of applications) {
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) {
      throw new LedgerRuleError('Each amount paid must be above zero.');
    }
  }
  const deposit = db.selectValue('SELECT type FROM account WHERE id = ?', [input.depositAccountId]);
  if (deposit !== 'asset') throw new LedgerRuleError('Choose the account the money went into.');
  const total = applications.reduce((s, a) => s + BigInt(a.amount), 0n);

  return inSavepoint(db, 'receive_payment', () => {
    const paymentId = crypto.randomUUID();
    db.exec({
      sql: `INSERT INTO customer_payment (id, company_id, customer_id, date, deposit_account_id, amount, method,
                                          ref, memo)
            VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        paymentId,
        input.customerId,
        input.date,
        input.depositAccountId,
        Number(total),
        input.method?.trim() || null,
        input.ref?.trim() || null,
        input.memo?.trim() || null,
      ],
    });
    for (const a of applications) {
      db.exec({
        sql: `INSERT INTO payment_application (payment_id, doc_id, company_id, amount)
              VALUES (?, ?, (SELECT id FROM company), ?)`,
        bind: [paymentId, a.docId, a.amount],
      });
    }
    const income = [...incomeByAccount(db, applications)].filter(([, v]) => v !== 0n);
    const numbers = applications.map((a) =>
      String(db.selectValue('SELECT number FROM sales_doc WHERE id = ?', [a.docId])),
    );
    const customer = db.selectValue('SELECT name FROM payee WHERE id = ?', [input.customerId]);
    const entryId = postEntry(
      db,
      {
        date: input.date,
        ref: input.ref,
        name: customer === undefined ? null : String(customer),
        memo:
          input.memo?.trim() ||
          `Payment for invoice${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')}`,
        sourceType: PAYMENT_SOURCE,
        sourceId: paymentId,
        lines: [
          { accountId: input.depositAccountId, debit: Number(total), credit: 0 },
          ...income.map(([accountId, v]) => ({
            accountId,
            debit: v < 0n ? Number(-v) : 0,
            credit: v > 0n ? Number(v) : 0,
          })),
        ],
      },
      opts,
    );
    db.exec({
      sql: `UPDATE customer_payment SET entry_id = ?, status = 'posted' WHERE id = ?`,
      bind: [entryId, paymentId],
    });
    return { paymentId, entryId };
  });
}

/** Void a payment: its entry is voided, and the invoices are owed again. Returns the entry. */
export function voidPayment(
  db: Database,
  id: string,
  reason: string | null,
  opts: PostOptions = {},
): number {
  const r = db.selectObjects('SELECT status, entry_id FROM customer_payment WHERE id = ?', [id])[0];
  if (!r) throw new LedgerRuleError('That payment no longer exists.');
  if (r.status !== 'posted') throw new LedgerRuleError('This payment is already void.');
  voidEntry(db, Number(r.entry_id), reason ?? 'Payment voided', opts);
  return Number(r.entry_id);
}

/** Payments, newest first: a customer's, or those applied to an invoice. */
export function listPayments(
  db: Database,
  q: { customerId?: string | null; docId?: string | null } = {},
): Payment[] {
  const where: string[] = [];
  const bind: string[] = [];
  if (q.customerId) {
    where.push('p.customer_id = ?');
    bind.push(q.customerId);
  }
  if (q.docId) {
    where.push(
      'EXISTS (SELECT 1 FROM payment_application a WHERE a.payment_id = p.id AND a.doc_id = ?)',
    );
    bind.push(q.docId);
  }
  return db
    .selectObjects(
      `SELECT p.*, c.name AS customer FROM customer_payment p JOIN payee c ON c.id = p.customer_id
       WHERE p.status <> 'draft' ${where.length ? `AND ${where.join(' AND ')}` : ''}
       ORDER BY p.date DESC, p.created_at DESC`,
      bind.length ? bind : undefined,
    )
    .map((r) => ({
      id: String(r.id),
      customerId: String(r.customer_id),
      customer: String(r.customer),
      date: String(r.date),
      depositAccountId: String(r.deposit_account_id),
      amount: Number(r.amount),
      method: text(r.method),
      ref: text(r.ref),
      memo: text(r.memo),
      entryId: r.entry_id === null ? null : Number(r.entry_id),
      status: r.status as Payment['status'],
      applications: db
        .selectObjects(
          `SELECT a.doc_id, d.number, a.amount FROM payment_application a JOIN sales_doc d ON d.id = a.doc_id
           WHERE a.payment_id = ? ORDER BY d.number`,
          [String(r.id)],
        )
        .map((a) => ({
          docId: String(a.doc_id),
          number: String(a.number),
          amount: Number(a.amount),
        })),
    }));
}
