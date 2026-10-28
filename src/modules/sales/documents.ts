// Estimates and invoices (AR-3 to AR-5). Documents only: nothing here posts.
// A payment against an invoice posts its income (payments.ts). Paid, partly
// paid and overdue are worked out from the payments and the due date; the
// stored status says only draft, sent, accepted, declined or void.

import type { Cents } from '../../shared/money';
import { addDays, stateOf } from './math';

export { addDays, lineAmount, stateOf } from './math';
import { isIsoDate } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';

export type DocKind = 'estimate' | 'invoice';
export type StoredStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'void';
/** What the owner sees: paid, partly paid and overdue come from payments and the due date */
export type DocState = StoredStatus | 'partial' | 'paid' | 'overdue';

export interface DocLineInput {
  itemId: string | null;
  description: string | null;
  /** Thousandths: 2.5 units is 2500 */
  quantity: number | null;
  rate: Cents | null;
  /** What the line charges; negative for a discount */
  amount: Cents;
  incomeAccountId: string;
}

export interface DocInput {
  kind: DocKind;
  number: string;
  customerId: string;
  date: string;
  /** Invoices: from the customer's terms if left out */
  dueDate: string | null;
  termsDays: number | null;
  memo: string | null;
  lines: DocLineInput[];
}

export interface Doc extends DocInput {
  id: string;
  customer: string;
  status: StoredStatus;
  state: DocState;
  total: Cents;
  paid: Cents;
  owed: Cents;
  sentAt: string | null;
  convertedTo: string | null;
  recurringId: string | null;
  /** Payments (not void) have applied: lines and customer are fixed */
  hasPayments: boolean;
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

const SELECT = `
  SELECT d.*, p.name AS customer,
         coalesce((SELECT sum(amount) FROM sales_doc_line WHERE doc_id = d.id), 0) AS total,
         coalesce((SELECT paid FROM invoice_paid WHERE doc_id = d.id), 0) AS paid
  FROM sales_doc d JOIN payee p ON p.id = d.customer_id`;

function lines(db: Database, id: string): DocLineInput[] {
  return db
    .selectObjects('SELECT * FROM sales_doc_line WHERE doc_id = ? ORDER BY line_no', [id])
    .map((l) => ({
      itemId: text(l.item_id),
      description: text(l.description),
      quantity: l.quantity === null ? null : Number(l.quantity),
      rate: l.rate === null ? null : Number(l.rate),
      amount: Number(l.amount),
      incomeAccountId: String(l.income_account_id),
    }));
}

function doc(db: Database, r: Record<string, unknown>, today: string, withLines = true): Doc {
  const total = Number(r.total);
  const paid = Number(r.paid);
  const base = {
    kind: r.kind as DocKind,
    status: r.status as StoredStatus,
    dueDate: text(r.due_date),
    total,
    paid,
  };
  return {
    ...base,
    id: String(r.id),
    number: String(r.number),
    customerId: String(r.customer_id),
    customer: String(r.customer),
    date: String(r.date),
    termsDays: r.terms_days === null ? null : Number(r.terms_days),
    memo: text(r.memo),
    lines: withLines ? lines(db, String(r.id)) : [],
    state: stateOf(base, today),
    owed: base.kind === 'invoice' && base.status !== 'void' ? total - paid : 0,
    sentAt: text(r.sent_at),
    convertedTo: text(r.converted_to),
    recurringId: text(r.recurring_id),
    hasPayments: paid > 0,
  };
}

export function getDoc(db: Database, id: string, today: string): Doc {
  const r = db.selectObjects(`${SELECT} WHERE d.id = ?`, [id])[0];
  if (!r) throw new LedgerRuleError('That document no longer exists.');
  return doc(db, r, today);
}

export interface DocQuery {
  kind: DocKind;
  customerId?: string | null;
  /** Invoices with something still owed */
  openOnly?: boolean;
}

/** Newest first, without their lines. */
export function listDocs(db: Database, q: DocQuery, today: string): Doc[] {
  const where = ['d.kind = ?'];
  const bind: string[] = [q.kind];
  if (q.customerId) {
    where.push('d.customer_id = ?');
    bind.push(q.customerId);
  }
  const rows = db
    .selectObjects(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY d.date DESC, d.number DESC`,
      bind,
    )
    .map((r) => doc(db, r, today, false));
  return q.openOnly ? rows.filter((d) => d.owed > 0) : rows;
}

/** The next number: one more than the highest numeric number of that kind, from 1001. */
export function nextNumber(db: Database, kind: DocKind): string {
  const numbers = db
    .selectValues('SELECT number FROM sales_doc WHERE kind = ?', [kind])
    .map((n) => (/^\d+$/.test(String(n)) ? Number(n) : 0));
  return String(Math.max(1000, ...numbers) + 1);
}

function problems(db: Database, input: DocInput, id: string | null): string[] {
  const out: string[] = [];
  if (!input.number.trim()) out.push('Give the document a number.');
  const clash = db.selectValue(
    `SELECT number FROM sales_doc WHERE kind = ? AND number = ? COLLATE NOCASE AND id IS NOT ?`,
    [input.kind, input.number.trim(), id],
  );
  if (clash !== undefined) {
    out.push(
      `There is already ${input.kind === 'invoice' ? 'an invoice' : 'an estimate'} number ${String(clash)}.`,
    );
  }
  if (!db.selectValue('SELECT 1 FROM payee WHERE id = ?', [input.customerId]))
    out.push('Choose the customer.');
  if (!isIsoDate(input.date)) out.push('Enter a valid date.');
  if (input.dueDate && (!isIsoDate(input.dueDate) || input.dueDate < input.date)) {
    out.push('The due date must be on or after the date.');
  }
  const used = input.lines.filter((l) => l.amount !== 0 || l.itemId || l.description?.trim());
  if (used.length === 0) out.push('Add at least one line.');
  for (const l of used) {
    if (!Number.isSafeInteger(l.amount)) out.push('Each line needs an amount in cents.');
    const type = db.selectValue('SELECT type FROM account WHERE id = ?', [l.incomeAccountId]);
    if (type !== 'income') {
      out.push('Each line needs the income account it goes to.');
      break;
    }
  }
  const total = used.reduce((s, l) => s + BigInt(l.amount), 0n);
  if (input.kind === 'invoice' && total <= 0n) out.push('An invoice needs a total above zero.');
  return out;
}

function writeLines(db: Database, id: string, input: DocInput) {
  db.exec({ sql: 'DELETE FROM sales_doc_line WHERE doc_id = ?', bind: [id] });
  input.lines
    .filter((l) => l.amount !== 0 || l.itemId || l.description?.trim())
    .forEach((l, i) =>
      db.exec({
        sql: `INSERT INTO sales_doc_line (company_id, doc_id, line_no, item_id, description, quantity, rate,
                                          amount, income_account_id)
              VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?)`,
        bind: [
          id,
          i + 1,
          l.itemId,
          l.description?.trim() || null,
          l.quantity,
          l.rate,
          l.amount,
          l.incomeAccountId,
        ],
      }),
    );
}

function dueDateOf(input: DocInput): string | null {
  if (input.kind !== 'invoice') return input.dueDate || null;
  if (input.dueDate) return input.dueDate;
  return input.termsDays !== null && isIsoDate(input.date)
    ? addDays(input.date, input.termsDays)
    : input.date;
}

const fields = (input: DocInput) => [
  input.number.trim(),
  input.customerId,
  input.date,
  dueDateOf(input),
  input.termsDays,
  input.memo?.trim() || null,
];

/** A new estimate or invoice. Its customer becomes a customer (AR-1) if it wasn't one. */
export function createDoc(
  db: Database,
  input: DocInput,
  recurringId: string | null = null,
): string {
  const p = problems(db, input, null);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  const id = crypto.randomUUID();
  inSavepoint(db, 'doc_create', () => {
    db.exec({
      sql: `INSERT INTO sales_doc (id, company_id, kind, number, customer_id, date, due_date, terms_days, memo,
                                   recurring_id)
            VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [id, input.kind, ...fields(input), recurringId],
    });
    writeLines(db, id, input);
    db.exec({
      sql: 'UPDATE payee SET is_customer = 1 WHERE id = ? AND is_customer = 0',
      bind: [input.customerId],
    });
  });
  return id;
}

/** Change a document; an invoice with payments keeps its lines and customer (the schema says so). */
export function updateDoc(db: Database, id: string, input: DocInput, today: string): void {
  const p = problems(db, input, id);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  inSavepoint(db, 'doc_update', () => {
    const before = getDoc(db, id, today);
    if (before.kind !== input.kind)
      throw new LedgerRuleError('A document stays an estimate or an invoice.');
    if (before.hasPayments) {
      // Only what doesn't touch what was paid
      db.exec({
        sql: 'UPDATE sales_doc SET number = ?, date = ?, due_date = ?, terms_days = ?, memo = ? WHERE id = ?',
        bind: [
          input.number.trim(),
          input.date,
          dueDateOf(input),
          input.termsDays,
          input.memo?.trim() || null,
          id,
        ],
      });
      return;
    }
    db.exec({
      sql: `UPDATE sales_doc SET number = ?, customer_id = ?, date = ?, due_date = ?, terms_days = ?, memo = ?
            WHERE id = ?`,
      bind: [...fields(input), id],
    });
    writeLines(db, id, input);
  });
}

export function voidDoc(db: Database, id: string): void {
  db.exec({
    sql: `UPDATE sales_doc SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    bind: [id],
  });
}

/** Delete a document no payment ever applied to (drafts made by mistake). */
export function deleteDoc(db: Database, id: string): void {
  inSavepoint(db, 'doc_delete', () => {
    db.exec({ sql: 'DELETE FROM sales_doc_line WHERE doc_id = ?', bind: [id] });
    db.exec({ sql: 'DELETE FROM sales_doc WHERE id = ?', bind: [id] });
  });
}

/** Sent to the customer (by the share sheet, the mail app, or by hand). */
export function markSent(db: Database, id: string): void {
  db.exec({
    sql: `UPDATE sales_doc SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
                              sent_at = coalesce(sent_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          WHERE id = ? AND status <> 'void'`,
    bind: [id],
  });
}

export function setEstimateStatus(
  db: Database,
  id: string,
  status: 'accepted' | 'declined' | 'sent',
): void {
  db.exec({
    sql: `UPDATE sales_doc SET status = ? WHERE id = ? AND kind = 'estimate'`,
    bind: [status, id],
  });
}

/** An invoice from an estimate's lines; the estimate is marked accepted (AR-3). Returns the invoice. */
export function convertEstimate(db: Database, id: string, date: string, today: string): string {
  return inSavepoint(db, 'estimate_convert', () => {
    const e = getDoc(db, id, today);
    if (e.kind !== 'estimate') throw new LedgerRuleError('Only an estimate becomes an invoice.');
    if (e.convertedTo) throw new LedgerRuleError('This estimate is already an invoice.');
    if (e.status === 'void') throw new LedgerRuleError('This estimate is void.');
    const terms = db.selectValue('SELECT terms_days FROM payee WHERE id = ?', [e.customerId]);
    const invoice = createDoc(db, {
      kind: 'invoice',
      number: nextNumber(db, 'invoice'),
      customerId: e.customerId,
      date,
      dueDate: null,
      termsDays: terms === null || terms === undefined ? null : Number(terms),
      memo: e.memo,
      lines: e.lines,
    });
    db.exec({
      sql: `UPDATE sales_doc SET status = 'accepted', converted_to = ? WHERE id = ?`,
      bind: [invoice, id],
    });
    return invoice;
  });
}

export interface CustomerBalance {
  customerId: string;
  customer: string;
  owed: Cents;
  overdue: Cents;
  invoices: number;
  oldestDue: string | null;
}

/** What each customer still owes on invoices, most first. */
export function customerBalances(db: Database, today: string): CustomerBalance[] {
  const open = listDocs(db, { kind: 'invoice', openOnly: true }, today);
  const by = new Map<string, CustomerBalance>();
  for (const d of open) {
    const b = by.get(d.customerId) ?? {
      customerId: d.customerId,
      customer: d.customer,
      owed: 0,
      overdue: 0,
      invoices: 0,
      oldestDue: null,
    };
    b.owed += d.owed;
    if (d.state === 'overdue') b.overdue += d.owed;
    b.invoices++;
    if (d.dueDate && (!b.oldestDue || d.dueDate < b.oldestDue)) b.oldestDue = d.dueDate;
    by.set(d.customerId, b);
  }
  return [...by.values()].sort((a, b) => b.owed - a.owed);
}
