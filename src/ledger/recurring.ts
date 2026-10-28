// Recurring journal entries (GL-5): monthly depreciation and the like. A
// template holds an entry's lines and a schedule; postDue() posts every date
// that has come, through the one posting path, when the company is opened
// (nothing runs while the app is closed). It never uses the closing-date
// override: a date in a closed period, or an inactive account, leaves that
// template waiting with the reason, for the owner to post or skip.

import type { Cents } from '../shared/money';
import { FREQUENCIES, firstDate, nextDate, type Frequency } from '../shared/schedule';
import { ClosedPeriodError, LedgerRuleError, fromRule } from '../worker/errors';
import type { Database } from '../worker/sqlite';
import { isIsoDate, postEntry, validateEntry, type PostOptions } from './postEntry';
import { inSavepoint } from './tx';

/** source_type of posted recurring entries; source_id is the template's id. */
export const RECURRING_SOURCE = 'recurring';

/** At most this many dates per template in one go, so a long absence can't run away. */
export const CATCH_UP_LIMIT = 36;

export { firstDate, nextDate, type Frequency };

export interface RecurringLine {
  accountId: string;
  debit: Cents;
  credit: Cents;
  memo: string | null;
}

export interface RecurringInput {
  name: string;
  frequency: Frequency;
  /** 1 to 31; past the month's end means its last day */
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
  ref: string | null;
  payee: string | null;
  memo: string | null;
  lines: RecurringLine[];
}

export interface Recurring extends RecurringInput {
  id: string;
  active: boolean;
  /** The next date to post, or null once past the end date */
  nextDate: string | null;
  /** Total debits: what each entry moves */
  amount: Cents;
  lastPosted: string | null;
  /** Posted at least once, so it can't be deleted */
  hasRuns: boolean;
}

export interface RecurringResult {
  posted: { entryId: number; recurringId: string; name: string; date: string }[];
  /** Templates that couldn't post their next date, and why */
  waiting: { recurringId: string; name: string; date: string; reason: string }[];
}

const text = (v: unknown) => (v === null || v === undefined ? null : String(v));

function problems(input: RecurringInput): string[] {
  const out: string[] = [];
  if (!input.name.trim()) out.push('Give the recurring entry a name.');
  if (!(input.frequency in FREQUENCIES)) out.push('Choose how often it repeats.');
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) {
    out.push('The day of the month is 1 to 31.');
  }
  if (!isIsoDate(input.startDate)) out.push('Enter a valid start date.');
  if (input.endDate && !isIsoDate(input.endDate)) out.push('Enter a valid end date.');
  if (input.endDate && isIsoDate(input.startDate) && input.endDate < input.startDate) {
    out.push('The end date is before the start.');
  }
  // The same checks as a posting, so a template never fails for its shape
  out.push(
    ...validateEntry({
      date: isIsoDate(input.startDate) ? input.startDate : '2000-01-01',
      sourceType: RECURRING_SOURCE,
      lines: input.lines,
    }).filter((p) => p !== 'Enter a valid date.'),
  );
  return out;
}

const SELECT = `
  SELECT r.*,
         (SELECT coalesce(sum(debit), 0) FROM recurring_line WHERE recurring_id = r.id) AS amount,
         (SELECT max(date) FROM recurring_run WHERE recurring_id = r.id) AS last_posted
  FROM recurring_entry r`;

function lines(db: Database, id: string): RecurringLine[] {
  return db
    .selectObjects(
      `SELECT account_id, debit, credit, memo FROM recurring_line WHERE recurring_id = ? ORDER BY line_no`,
      [id],
    )
    .map((l) => ({
      accountId: String(l.account_id),
      debit: Number(l.debit),
      credit: Number(l.credit),
      memo: text(l.memo),
    }));
}

function recurring(db: Database, r: Record<string, unknown>): Recurring {
  const id = String(r.id);
  return {
    id,
    name: String(r.name),
    active: r.active === 1,
    frequency: r.frequency as Frequency,
    dayOfMonth: Number(r.day_of_month),
    startDate: String(r.start_date),
    endDate: text(r.end_date),
    nextDate: text(r.next_date),
    ref: text(r.ref),
    payee: text(r.payee),
    memo: text(r.memo),
    lines: lines(db, id),
    amount: Number(r.amount),
    lastPosted: text(r.last_posted),
    hasRuns: r.last_posted !== null,
  };
}

export function listRecurring(db: Database): Recurring[] {
  return db
    .selectObjects(`${SELECT} ORDER BY r.active DESC, r.name COLLATE NOCASE`)
    .map((r) => recurring(db, r));
}

export function getRecurring(db: Database, id: string): Recurring {
  const r = db.selectObjects(`${SELECT} WHERE r.id = ?`, [id])[0];
  if (!r) throw new LedgerRuleError('That recurring entry no longer exists.');
  return recurring(db, r);
}

function writeLines(db: Database, id: string, input: RecurringInput) {
  db.exec({ sql: 'DELETE FROM recurring_line WHERE recurring_id = ?', bind: [id] });
  input.lines
    .filter((l) => l.debit !== 0 || l.credit !== 0)
    .forEach((l, i) =>
      db.exec({
        sql: `INSERT INTO recurring_line (company_id, recurring_id, line_no, account_id, debit, credit, memo)
              VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?)`,
        bind: [id, i + 1, l.accountId, l.debit, l.credit, l.memo?.trim() || null],
      }),
    );
}

/**
 * The next date to post for a schedule: its first date, or for a template
 * that has posted, the first scheduled date after its last run. Null once
 * past the end date.
 */
function scheduledNext(db: Database, id: string | null, input: RecurringInput): string | null {
  const last = id
    ? (db.selectValue('SELECT max(date) FROM recurring_run WHERE recurring_id = ?', [id]) as
        string | null)
    : null;
  // Skipped dates stay skipped
  const current = id
    ? (db.selectValue('SELECT next_date FROM recurring_entry WHERE id = ?', [id]) as string | null)
    : null;
  let next = firstDate(input.startDate, input.dayOfMonth);
  while ((last && next <= last) || (current && next < current)) {
    next = nextDate(next, input.frequency, input.dayOfMonth);
  }
  return input.endDate && next > input.endDate ? null : next;
}

const fields = (input: RecurringInput) => [
  input.name.trim(),
  input.frequency,
  input.dayOfMonth,
  input.startDate,
  input.endDate || null,
  input.ref?.trim() || null,
  input.payee?.trim() || null,
  input.memo?.trim() || null,
];

export function createRecurring(db: Database, input: RecurringInput): string {
  const p = problems(input);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  const id = crypto.randomUUID();
  inSavepoint(db, 'recurring_create', () => {
    db.exec({
      sql: `INSERT INTO recurring_entry (id, company_id, name, frequency, day_of_month, start_date, end_date,
                                         ref, payee, memo, next_date)
            VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [id, ...fields(input), scheduledNext(db, null, input)],
    });
    writeLines(db, id, input);
  });
  return id;
}

/** Change a template; its next date follows the new schedule after what has posted. */
export function updateRecurring(db: Database, id: string, input: RecurringInput): void {
  const p = problems(input);
  if (p.length) throw new LedgerRuleError(p.join(' '));
  inSavepoint(db, 'recurring_update', () => {
    getRecurring(db, id);
    db.exec({
      sql: `UPDATE recurring_entry SET name = ?, frequency = ?, day_of_month = ?, start_date = ?, end_date = ?,
                                       ref = ?, payee = ?, memo = ?, next_date = ?
            WHERE id = ?`,
      bind: [...fields(input), scheduledNext(db, id, input), id],
    });
    writeLines(db, id, input);
  });
}

export function setRecurringActive(db: Database, id: string, active: boolean): void {
  getRecurring(db, id);
  db.exec({
    sql: 'UPDATE recurring_entry SET active = ? WHERE id = ?',
    bind: [active ? 1 : 0, id],
  });
}

/** Delete a template that has never posted (the schema refuses others). */
export function deleteRecurring(db: Database, id: string): void {
  inSavepoint(db, 'recurring_delete', () => {
    getRecurring(db, id);
    db.exec({ sql: 'DELETE FROM recurring_line WHERE recurring_id = ?', bind: [id] });
    db.exec({ sql: 'DELETE FROM recurring_entry WHERE id = ?', bind: [id] });
  });
}

function advance(db: Database, r: Recurring) {
  const next = nextDate(r.nextDate!, r.frequency, r.dayOfMonth);
  db.exec({
    sql: 'UPDATE recurring_entry SET next_date = ? WHERE id = ?',
    bind: [r.endDate && next > r.endDate ? null : next, r.id],
  });
}

/** Post the template's next date and advance it, in one savepoint. Returns the entry. */
function postNext(db: Database, r: Recurring, opts: PostOptions = {}): number {
  return inSavepoint(db, 'recurring_post', () => {
    const date = r.nextDate!;
    const entryId = postEntry(
      db,
      {
        date,
        ref: r.ref,
        name: r.payee,
        memo: r.memo ?? r.name,
        sourceType: RECURRING_SOURCE,
        sourceId: r.id,
        lines: r.lines,
      },
      opts,
    );
    db.exec({
      sql: `INSERT INTO recurring_run (recurring_id, date, company_id, entry_id)
            VALUES (?, ?, (SELECT id FROM company), ?)`,
      bind: [r.id, date, entryId],
    });
    advance(db, r);
    return entryId;
  });
}

const reasonOf = (raw: unknown) => {
  const e = fromRule(raw);
  return e instanceof ClosedPeriodError
    ? 'the date is in a closed period'
    : e instanceof LedgerRuleError
      ? e.message.replace(/\.$/, '').replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase())
      : e instanceof Error
        ? e.message
        : String(e);
};

/**
 * Post every date that has come for every active template, oldest first. A
 * template that can't post stops there and waits, with the reason.
 */
export function postDue(db: Database, today: string): RecurringResult {
  const result: RecurringResult = { posted: [], waiting: [] };
  for (const t of listRecurring(db).filter((x) => x.active)) {
    for (let n = 0; ; n++) {
      const r = n === 0 ? t : getRecurring(db, t.id);
      if (!r.nextDate || r.nextDate > today) break;
      if (n === CATCH_UP_LIMIT) {
        result.waiting.push({
          recurringId: r.id,
          name: r.name,
          date: r.nextDate,
          reason: `more than ${CATCH_UP_LIMIT} dates were due at once; use Post due now for the rest`,
        });
        break;
      }
      try {
        const entryId = postNext(db, r);
        result.posted.push({ entryId, recurringId: r.id, name: r.name, date: r.nextDate });
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

/** Post a template's next date now, e.g. one waiting in a closed period with the owner's passphrase. */
export function postNow(db: Database, id: string, opts: PostOptions = {}): number {
  const r = getRecurring(db, id);
  if (!r.nextDate) throw new LedgerRuleError('This recurring entry has ended.');
  return postNext(db, r, opts);
}

/** Skip the next date without posting it, e.g. a month with nothing to record. */
export function skipNext(db: Database, id: string): void {
  const r = getRecurring(db, id);
  if (!r.nextDate) throw new LedgerRuleError('This recurring entry has ended.');
  advance(db, r);
}
