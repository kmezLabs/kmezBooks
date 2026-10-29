// Bills (AP-2, AP-4, AP-5). Documents only: nothing here posts. A payment
// against a bill posts its expenses (billPayments.ts). Paid, partly paid and
// overdue are worked out from the payments and the due date; the stored
// status says only open or void.

import { isIsoDate } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import type { Cents } from '../../shared/money';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';
import { addDays } from '../../shared/periods';
import { NOT_ON_BILLS, billState, type BillState } from './billRules';

export { billState, type BillState } from './billRules';

export interface BillLineInput {
  accountId: string;
  description: string | null;
  /** What the line costs; negative for a credit */
  amount: Cents;
}

export interface BillInput {
  vendorId: string;
  /** The vendor's own number; optional */
  number: string | null;
  date: string;
  /** From the vendor's terms if left out */
  dueDate: string | null;
  termsDays: number | null;
  memo: string | null;
  lines: BillLineInput[];
}

export interface Bill extends BillInput {
  id: string;
  vendor: string;
  dueDate: string;
  status: 'open' | 'void';
  state: BillState;
  total: Cents;
  paid: Cents;
  owed: Cents;
  /** Payments (not void) have applied: lines and vendor are fixed */
  hasPayments: boolean;
  attachments: number;
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

const SELECT = `
  SELECT b.*, p.name AS vendor,
         coalesce((SELECT sum(amount) FROM bill_line WHERE bill_id = b.id), 0) AS total,
         coalesce((SELECT paid FROM bill_paid WHERE bill_id = b.id), 0) AS paid,
         (SELECT count(*) FROM attachment WHERE entity = 'bill' AND entity_id = b.id) AS attachments
  FROM bill b JOIN payee p ON p.id = b.vendor_id`;

function lines(db: Database, id: string): BillLineInput[] {
  return db
    .selectObjects('SELECT * FROM bill_line WHERE bill_id = ? ORDER BY line_no', [id])
    .map((l) => ({
      accountId: String(l.account_id),
      description: text(l.description),
      amount: Number(l.amount),
    }));
}

function bill(db: Database, r: Record<string, unknown>, today: string, withLines = true): Bill {
  const total = Number(r.total);
  const paid = Number(r.paid);
  const status = r.status as 'open' | 'void';
  const dueDate = String(r.due_date);
  return {
    id: String(r.id),
    vendorId: String(r.vendor_id),
    vendor: String(r.vendor),
    number: text(r.number),
    date: String(r.date),
    dueDate,
    termsDays: r.terms_days === null ? null : Number(r.terms_days),
    memo: text(r.memo),
    lines: withLines ? lines(db, String(r.id)) : [],
    status,
    state: billState({ status, dueDate, total, paid }, today),
    total,
    paid,
    owed: status === 'void' ? 0 : total - paid,
    hasPayments: paid > 0,
    attachments: Number(r.attachments),
  };
}

export function getBill(db: Database, id: string, today: string): Bill {
  const r = db.selectObjects(`${SELECT} WHERE b.id = ?`, [id])[0];
  if (!r) throw new LedgerRuleError('That bill no longer exists.');
  return bill(db, r, today);
}

export interface BillQuery {
  vendorId?: string | null;
  /** Bills with something still owed, by due date, oldest first (AP-5) */
  openOnly?: boolean;
}

/** Newest first, or for bills due, by due date; without their lines. */
export function listBills(db: Database, q: BillQuery, today: string): Bill[] {
  const where: string[] = [];
  const bind: string[] = [];
  if (q.vendorId) {
    where.push('b.vendor_id = ?');
    bind.push(q.vendorId);
  }
  const order = q.openOnly ? 'b.due_date, b.date, p.name' : 'b.date DESC, b.created_at DESC';
  const rows = db
    .selectObjects(
      `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
      bind.length ? bind : undefined,
    )
    .map((r) => bill(db, r, today, false));
  return q.openOnly ? rows.filter((b) => b.owed > 0) : rows;
}

const used = (l: BillLineInput) => l.amount !== 0 || !!l.description?.trim();

function problems(db: Database, input: BillInput): string[] {
  const out: string[] = [];
  if (!db.selectValue('SELECT 1 FROM payee WHERE id = ?', [input.vendorId]))
    out.push('Choose the vendor.');
  if (!isIsoDate(input.date)) out.push('Enter a valid date.');
  if (input.dueDate && (!isIsoDate(input.dueDate) || input.dueDate < input.date)) {
    out.push('The due date must be on or after the date.');
  }
  const lines = input.lines.filter(used);
  if (lines.length === 0) out.push('Add at least one line.');
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount)) out.push('Each line needs an amount in cents.');
    const detail = db.selectValue('SELECT detail_type FROM account WHERE id = ?', [l.accountId]);
    if (detail === undefined || NOT_ON_BILLS.includes(String(detail))) {
      out.push(
        'Each line needs the expense account it goes to (not a bank, card, A/R or A/P account).',
      );
      break;
    }
  }
  if (lines.reduce((s, l) => s + BigInt(l.amount), 0n) <= 0n)
    out.push('A bill needs a total above zero.');
  return out;
}

function writeLines(db: Database, id: string, input: BillInput) {
  db.exec({ sql: 'DELETE FROM bill_line WHERE bill_id = ?', bind: [id] });
  input.lines.filter(used).forEach((l, i) =>
    db.exec({
      sql: `INSERT INTO bill_line (company_id, bill_id, line_no, account_id, description, amount)
            VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?)`,
      bind: [id, i + 1, l.accountId, l.description?.trim() || null, l.amount],
    }),
  );
}

/** The due date: as entered, or the date plus the terms (on the date without). */
function dueDateOf(input: BillInput): string {
  if (input.dueDate) return input.dueDate;
  return input.termsDays !== null && isIsoDate(input.date)
    ? addDays(input.date, input.termsDays)
    : input.date;
}

/** A new bill. Its vendor becomes a vendor (AP-1) if it wasn't one. */
export function createBill(db: Database, input: BillInput): string {
  const p = problems(db, input);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  const id = crypto.randomUUID();
  inSavepoint(db, 'bill_create', () => {
    db.exec({
      sql: `INSERT INTO bill (id, company_id, vendor_id, number, date, due_date, terms_days, memo)
            VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?)`,
      bind: [
        id,
        input.vendorId,
        input.number?.trim() || null,
        input.date,
        dueDateOf(input),
        input.termsDays,
        input.memo?.trim() || null,
      ],
    });
    writeLines(db, id, input);
    db.exec({
      sql: 'UPDATE payee SET is_vendor = 1 WHERE id = ? AND is_vendor = 0',
      bind: [input.vendorId],
    });
  });
  return id;
}

/** Change a bill; one with payments keeps its lines and vendor (the schema says so). */
export function updateBill(db: Database, id: string, input: BillInput, today: string): void {
  const p = problems(db, input);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  inSavepoint(db, 'bill_update', () => {
    const before = getBill(db, id, today);
    const common = [
      input.number?.trim() || null,
      input.date,
      dueDateOf(input),
      input.termsDays,
      input.memo?.trim() || null,
    ];
    if (before.hasPayments) {
      db.exec({
        sql: 'UPDATE bill SET number = ?, date = ?, due_date = ?, terms_days = ?, memo = ? WHERE id = ?',
        bind: [...common, id],
      });
      return;
    }
    db.exec({
      sql: `UPDATE bill SET vendor_id = ?, number = ?, date = ?, due_date = ?, terms_days = ?, memo = ?
            WHERE id = ?`,
      bind: [input.vendorId, ...common, id],
    });
    writeLines(db, id, input);
  });
}

export function voidBill(db: Database, id: string): void {
  db.exec({
    sql: `UPDATE bill SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ? AND status = 'open'`,
    bind: [id],
  });
}

/**
 * Delete a bill no payment ever applied to (entered by mistake). Its
 * attachments are unlinked; their encrypted files stay, as for entries.
 */
export function deleteBill(db: Database, id: string): void {
  inSavepoint(db, 'bill_delete', () => {
    db.exec({ sql: `DELETE FROM attachment WHERE entity = 'bill' AND entity_id = ?`, bind: [id] });
    db.exec({ sql: 'DELETE FROM bill_line WHERE bill_id = ?', bind: [id] });
    db.exec({ sql: 'DELETE FROM bill WHERE id = ?', bind: [id] });
  });
}

export interface BillsDue {
  owed: Cents;
  overdue: Cents;
  /** Due in the next 7 days */
  dueSoon: Cents;
}

/** What is owed on bills, of which overdue and due within a week (AP-5). */
export function billsDue(db: Database, today: string): BillsDue {
  const week = addDays(today, 7);
  const out: BillsDue = { owed: 0, overdue: 0, dueSoon: 0 };
  for (const b of listBills(db, { openOnly: true }, today)) {
    out.owed += b.owed;
    if (b.state === 'overdue') out.overdue += b.owed;
    else if (b.dueDate <= week) out.dueSoon += b.owed;
  }
  return out;
}
