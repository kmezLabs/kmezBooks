// Recurring invoices (AR-9): monthly tuition and the like. A template holds an
// invoice's customer, lines and a schedule; createDue() makes an invoice for
// every date that has come, when the company is opened (nothing runs while
// the app is closed). The invoices are drafts, to check and send; nothing
// posts until a customer pays (cash basis, GL-8). A date that can't be made
// leaves its template waiting with the reason.

import { isIsoDate } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import type { Cents } from '../../shared/money';
import { FREQUENCIES, nextDate, upcomingDate, type Frequency } from '../../shared/schedule';
import { LedgerRuleError, fromRule } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';
import { createDoc, nextNumber, type DocLineInput } from './documents';

/** At most this many dates per template in one go, as recurring entries (GL-5). */
export const CATCH_UP_LIMIT = 36;

export interface RecurringInvoiceInput {
  name: string;
  customerId: string;
  frequency: Frequency;
  /** 1 to 31; past the month's end means its last day */
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
  /** Each invoice is due this many days after its date; null is due on receipt */
  termsDays: number | null;
  memo: string | null;
  lines: DocLineInput[];
}

export interface RecurringInvoice extends RecurringInvoiceInput {
  id: string;
  customer: string;
  active: boolean;
  /** The next date to make, or null once past the end date */
  nextDate: string | null;
  total: Cents;
  lastMade: string | null;
  /** Has made invoices, so it can't be deleted */
  hasRuns: boolean;
}

export interface RecurringInvoiceResult {
  created: {
    docId: string;
    recurringId: string;
    name: string;
    customer: string;
    number: string;
    date: string;
  }[];
  /** Templates that couldn't make their next date, and why */
  waiting: { recurringId: string; name: string; date: string; reason: string }[];
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
const used = (l: DocLineInput) => l.amount !== 0 || !!l.itemId || !!l.description?.trim();

function problems(db: Database, input: RecurringInvoiceInput): string[] {
  const out: string[] = [];
  if (!input.name.trim()) out.push('Give the recurring invoice a name.');
  if (!db.selectValue('SELECT 1 FROM payee WHERE id = ?', [input.customerId]))
    out.push('Choose the customer.');
  if (!(input.frequency in FREQUENCIES)) out.push('Choose how often it repeats.');
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
    out.push('The day of the month is 1 to 31.');
  }
  if (!isIsoDate(input.startDate)) out.push('Enter a valid start date.');
  if (input.endDate && !isIsoDate(input.endDate)) out.push('Enter a valid end date.');
  if (input.endDate && isIsoDate(input.startDate) && input.endDate < input.startDate) {
    out.push('The end date is before the start.');
  }
  if (
    input.termsDays !== null &&
    (!Number.isInteger(input.termsDays) || input.termsDays < 0 || input.termsDays > 365)
  ) {
    out.push('Terms are 0 to 365 days.');
  }
  const lines = input.lines.filter(used);
  if (lines.length === 0) out.push('Add at least one line.');
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount)) out.push('Each line needs an amount in cents.');
    const type = db.selectValue('SELECT type FROM account WHERE id = ?', [l.incomeAccountId]);
    if (type !== 'income') {
      out.push('Each line needs the income account it goes to.');
      break;
    }
  }
  // The same rule as an invoice, so a template never fails for its total
  if (lines.reduce((s, l) => s + BigInt(l.amount), 0n) <= 0n)
    out.push('An invoice needs a total above zero.');
  return out;
}

const SELECT = `
  SELECT r.*, p.name AS customer,
         (SELECT coalesce(sum(amount), 0) FROM recurring_invoice_line WHERE recurring_id = r.id) AS total,
         (SELECT max(date) FROM recurring_invoice_run WHERE recurring_id = r.id) AS last_made
  FROM recurring_invoice r JOIN payee p ON p.id = r.customer_id`;

function lines(db: Database, id: string): DocLineInput[] {
  return db
    .selectObjects('SELECT * FROM recurring_invoice_line WHERE recurring_id = ? ORDER BY line_no', [
      id,
    ])
    .map((l) => ({
      itemId: text(l.item_id),
      description: text(l.description),
      quantity: l.quantity === null ? null : Number(l.quantity),
      rate: l.rate === null ? null : Number(l.rate),
      amount: Number(l.amount),
      incomeAccountId: String(l.income_account_id),
    }));
}

function recurringInvoice(db: Database, r: Record<string, unknown>): RecurringInvoice {
  const id = String(r.id);
  return {
    id,
    name: String(r.name),
    customerId: String(r.customer_id),
    customer: String(r.customer),
    active: r.active === 1,
    frequency: r.frequency as Frequency,
    dayOfMonth: Number(r.day_of_month),
    startDate: String(r.start_date),
    endDate: text(r.end_date),
    nextDate: text(r.next_date),
    termsDays: r.terms_days === null ? null : Number(r.terms_days),
    memo: text(r.memo),
    lines: lines(db, id),
    total: Number(r.total),
    lastMade: text(r.last_made),
    hasRuns: r.last_made !== null,
  };
}

export function listRecurringInvoices(db: Database): RecurringInvoice[] {
  return db
    .selectObjects(`${SELECT} ORDER BY r.active DESC, r.name COLLATE NOCASE`)
    .map((r) => recurringInvoice(db, r));
}

export function getRecurringInvoice(db: Database, id: string): RecurringInvoice {
  const r = db.selectObjects(`${SELECT} WHERE r.id = ?`, [id])[0];
  if (!r) throw new LedgerRuleError('That recurring invoice no longer exists.');
  return recurringInvoice(db, r);
}

function writeLines(db: Database, id: string, input: RecurringInvoiceInput) {
  db.exec({ sql: 'DELETE FROM recurring_invoice_line WHERE recurring_id = ?', bind: [id] });
  input.lines.filter(used).forEach((l, i) =>
    db.exec({
      sql: `INSERT INTO recurring_invoice_line (company_id, recurring_id, line_no, item_id, description, quantity,
                                                rate, amount, income_account_id)
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

/** The next date to make: after the last run, keeping skipped dates skipped. */
function scheduledNext(db: Database, id: string | null, input: RecurringInvoiceInput) {
  const last = id
    ? (db.selectValue('SELECT max(date) FROM recurring_invoice_run WHERE recurring_id = ?', [
        id,
      ]) as string | null)
    : null;
  const current = id
    ? (db.selectValue('SELECT next_date FROM recurring_invoice WHERE id = ?', [id]) as
        string | null)
    : null;
  return upcomingDate(input, last, current);
}

const fields = (input: RecurringInvoiceInput) => [
  input.name.trim(),
  input.customerId,
  input.frequency,
  input.dayOfMonth,
  input.startDate,
  input.endDate || null,
  input.termsDays,
  input.memo?.trim() || null,
];

export function createRecurringInvoice(db: Database, input: RecurringInvoiceInput): string {
  const p = problems(db, input);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  const id = crypto.randomUUID();
  inSavepoint(db, 'recurring_invoice_create', () => {
    db.exec({
      sql: `INSERT INTO recurring_invoice (id, company_id, name, customer_id, frequency, day_of_month, start_date,
                                           end_date, terms_days, memo, next_date)
            VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [id, ...fields(input), scheduledNext(db, null, input)],
    });
    writeLines(db, id, input);
  });
  return id;
}

/** Change a template; invoices already made stay as they are. */
export function updateRecurringInvoice(
  db: Database,
  id: string,
  input: RecurringInvoiceInput,
): void {
  const p = problems(db, input);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  inSavepoint(db, 'recurring_invoice_update', () => {
    getRecurringInvoice(db, id);
    db.exec({
      sql: `UPDATE recurring_invoice SET name = ?, customer_id = ?, frequency = ?, day_of_month = ?,
                                         start_date = ?, end_date = ?, terms_days = ?, memo = ?, next_date = ?
            WHERE id = ?`,
      bind: [...fields(input), scheduledNext(db, id, input), id],
    });
    writeLines(db, id, input);
  });
}

export function setRecurringInvoiceActive(db: Database, id: string, active: boolean): void {
  getRecurringInvoice(db, id);
  db.exec({
    sql: 'UPDATE recurring_invoice SET active = ? WHERE id = ?',
    bind: [active ? 1 : 0, id],
  });
}

/** Delete a template that has never made an invoice (the schema refuses others). */
export function deleteRecurringInvoice(db: Database, id: string): void {
  inSavepoint(db, 'recurring_invoice_delete', () => {
    getRecurringInvoice(db, id);
    db.exec({ sql: 'DELETE FROM recurring_invoice_line WHERE recurring_id = ?', bind: [id] });
    db.exec({ sql: 'DELETE FROM recurring_invoice WHERE id = ?', bind: [id] });
  });
}

function advance(db: Database, r: RecurringInvoice) {
  const next = nextDate(r.nextDate!, r.frequency, r.dayOfMonth);
  db.exec({
    sql: 'UPDATE recurring_invoice SET next_date = ? WHERE id = ?',
    bind: [r.endDate && next > r.endDate ? null : next, r.id],
  });
}

/** Make the template's next invoice, a draft, and advance it, in one savepoint. */
function makeNext(db: Database, r: RecurringInvoice): { docId: string; number: string } {
  return inSavepoint(db, 'recurring_invoice_make', () => {
    const date = r.nextDate!;
    const number = nextNumber(db, 'invoice');
    const docId = createDoc(
      db,
      {
        kind: 'invoice',
        number,
        customerId: r.customerId,
        date,
        dueDate: null,
        // Null terms make the invoice due on its date
        termsDays: r.termsDays,
        memo: r.memo,
        lines: r.lines,
      },
      r.id,
    );
    db.exec({
      sql: `INSERT INTO recurring_invoice_run (recurring_id, date, company_id, doc_id)
            VALUES (?, ?, (SELECT id FROM company), ?)`,
      bind: [r.id, date, docId],
    });
    advance(db, r);
    return { docId, number };
  });
}

const reasonOf = (raw: unknown) => {
  const e = fromRule(raw);
  return e instanceof LedgerRuleError
    ? e.message.replace(/\.$/, '').replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())
    : e instanceof Error
      ? e.message
      : String(e);
};

/**
 * Make an invoice for every date that has come for every active template,
 * oldest first. A template that can't make one stops there and waits, with
 * the reason.
 */
export function createDue(db: Database, today: string): RecurringInvoiceResult {
  const result: RecurringInvoiceResult = { created: [], waiting: [] };
  for (const t of listRecurringInvoices(db).filter((x) => x.active)) {
    for (let n = 0; ; n++) {
      const r = n === 0 ? t : getRecurringInvoice(db, t.id);
      if (!r.nextDate || r.nextDate > today) break;
      if (n === CATCH_UP_LIMIT) {
        result.waiting.push({
          recurringId: r.id,
          name: r.name,
          date: r.nextDate,
          reason: `more than ${CATCH_UP_LIMIT} dates were due at once; use Create due now for the rest`,
        });
        break;
      }
      try {
        const made = makeNext(db, r);
        result.created.push({
          ...made,
          recurringId: r.id,
          name: r.name,
          customer: r.customer,
          date: r.nextDate,
        });
      } catch (e) {
        result.waiting.push({
          recurringId: r.id,
          name: r.name,
          date: r.nextDate,
          reason: reasonOf(e),
        });
        break;
      }
    }
  }
  return result;
}

/** Make a template's next invoice now, before its date. Returns the invoice. */
export function createNow(db: Database, id: string): string {
  const r = getRecurringInvoice(db, id);
  if (!r.nextDate) throw new LedgerRuleError('This recurring invoice has ended.');
  return makeNext(db, r).docId;
}

/** Skip the next date without making it, e.g. a month off. */
export function skipNextInvoice(db: Database, id: string): void {
  const r = getRecurringInvoice(db, id);
  if (!r.nextDate) throw new LedgerRuleError('This recurring invoice has ended.');
  advance(db, r);
}
