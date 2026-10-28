// The one posting path (CLAUDE.md rule 4). Modules never write ledger rows
// themselves: they call postEntry(), which writes a draft and its lines and
// then posts it, all in one savepoint. The schema's triggers check the balance
// (GL-3), the closing date (PC-1), inactive accounts (GL-7) and the cash-basis
// rule (GL-8) whatever the caller does; validateEntry() just says it nicely first.
// Names on entries and lines become payees (GL-11), added on first use.

import { MAX_CENTS, type Cents } from '../shared/money';
import { LedgerRuleError } from '../worker/errors';
import type { Database } from '../worker/sqlite';
import { payeeFor } from './payees';
import { inSavepoint } from './tx';

export interface EntryLineInput {
  accountId: string;
  debit: Cents;
  credit: Cents;
  memo?: string | null;
  /** Someone other than the entry's payee, when a line names its own (MG-3) */
  name?: string | null;
}

export interface EntryInput {
  date: string;
  ref?: string | null;
  /** Payee, customer or vendor (MG-3, GL-11): the payee with this name, added if new */
  name?: string | null;
  memo?: string | null;
  /** Which kind of document produced the entry: 'journal', 'qbo_migration', … */
  sourceType: string;
  sourceId?: string | null;
  lines: EntryLineInput[];
}

export interface PostOptions {
  /** The owner confirmed a change in a closed period (PC-2); logged by the schema. */
  closingOverride?: boolean;
}

export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Readable problems with an entry before it reaches the database. */
export function validateEntry(e: EntryInput): string[] {
  const problems: string[] = [];
  if (!isIsoDate(e.date)) problems.push('Enter a valid date.');
  const lines = e.lines.filter((l) => l.debit !== 0 || l.credit !== 0 || l.accountId);
  if (lines.length < 2) problems.push('An entry needs at least two lines.');
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.accountId) problems.push(`Line ${n}: choose an account.`);
    for (const side of [l.debit, l.credit]) {
      if (!Number.isSafeInteger(side) || side < 0 || side > MAX_CENTS) {
        problems.push(`Line ${n}: amounts must be between 0 and 100 billion.`);
      }
    }
    if (l.debit > 0 && l.credit > 0)
      problems.push(`Line ${n}: enter a debit or a credit, not both.`);
    if (l.debit === 0 && l.credit === 0) problems.push(`Line ${n}: enter an amount.`);
  });
  const debits = lines.reduce((a, l) => a + BigInt(l.debit), 0n);
  const credits = lines.reduce((a, l) => a + BigInt(l.credit), 0n);
  if (debits !== credits) problems.push('Debits and credits must be equal.');
  return problems;
}

function withOverride<T>(db: Database, on: boolean | undefined, fn: () => T): T {
  if (!on) return fn();
  db.exec('UPDATE session SET closing_override = 1 WHERE id = 1');
  const result = fn();
  db.exec('UPDATE session SET closing_override = 0 WHERE id = 1');
  return result;
}

function writeLines(db: Database, id: number, lines: EntryLineInput[]) {
  const insert = db.prepare(
    `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit, credit, memo, name, payee_id)
     VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    lines.forEach((l, i) => {
      const payee = payeeFor(db, l.name);
      insert
        .bind([
          id,
          i + 1,
          l.accountId,
          l.debit,
          l.credit,
          l.memo?.trim() || null,
          payee?.name ?? null,
          payee?.id ?? null,
        ])
        .stepReset();
    });
  } finally {
    insert.finalize();
  }
}

/** Draft to posted: the schema checks balance, closing date and the cash-basis rule here. */
function postDraft(db: Database, id: number) {
  db.exec({
    sql: `UPDATE journal_entry SET status = 'posted', posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    bind: [id],
  });
}

function checked(input: EntryInput): EntryLineInput[] {
  const problems = validateEntry(input);
  if (problems.length) throw new LedgerRuleError(problems.join(' '));
  return input.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
}

/** Post a balanced entry. Returns the new entry's id. */
export function postEntry(db: Database, input: EntryInput, opts: PostOptions = {}): number {
  const lines = checked(input);
  return inSavepoint(db, 'post_entry', () =>
    withOverride(db, opts.closingOverride, () => {
      const payee = payeeFor(db, input.name);
      const id = Number(
        db.selectValue(
          `INSERT INTO journal_entry (company_id, date, ref, name, payee_id, memo, source_type, source_id)
           VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            input.date,
            input.ref?.trim() || null,
            payee?.name ?? null,
            payee?.id ?? null,
            input.memo?.trim() || null,
            input.sourceType,
            input.sourceId ?? null,
          ],
        ),
      );
      writeLines(db, id, lines);
      postDraft(db, id);
      return id;
    }),
  );
}

/** What changes when a posted entry is changed; where it came from stays. */
export type EntryChange = Omit<EntryInput, 'sourceType' | 'sourceId'>;

/** Bank transactions an entry accounts for, to link again after a change (BK-4). */
function bankLinks(db: Database, id: number) {
  return db.selectObjects(
    `SELECT id, account_id, amount, status FROM bank_txn WHERE entry_id = ?`,
    [id],
  );
}

/** Link the bank transactions again where the changed entry still moves their amount. */
function relink(db: Database, links: Record<string, unknown>[], entryId: number) {
  for (const b of links) {
    const net = Number(
      db.selectValue(
        `SELECT coalesce(sum(debit - credit), 0) FROM journal_line WHERE entry_id = ? AND account_id = ?`,
        [entryId, String(b.account_id)],
      ),
    );
    if (net === Number(b.amount)) {
      db.exec({
        sql: `UPDATE bank_txn SET status = ?, entry_id = ? WHERE id = ? AND status = 'new'`,
        bind: [String(b.status), entryId, Number(b.id)],
      });
    }
  }
}

function requirePosted(db: Database, id: number) {
  const status = db.selectValue('SELECT status FROM journal_entry WHERE id = ?', [id]);
  if (status !== 'posted') {
    throw new LedgerRuleError(
      status === 'void' ? 'This entry is void.' : 'That entry does not exist.',
    );
  }
}

/**
 * Change a posted entry in place, where the company allows it (GL-6 off): it
 * goes back to draft, its lines are rewritten, and it is posted again, so the
 * schema checks it like a new entry. The audit log keeps what it was.
 */
export function changeEntry(
  db: Database,
  id: number,
  change: EntryChange,
  opts: PostOptions = {},
): void {
  const source = db.selectObjects('SELECT source_type, source_id FROM journal_entry WHERE id = ?', [
    id,
  ])[0];
  const lines = checked({ ...change, sourceType: String(source?.source_type ?? 'journal') });
  inSavepoint(db, 'change_entry', () =>
    withOverride(db, opts.closingOverride, () => {
      requirePosted(db, id);
      const links = bankLinks(db, id);
      db.exec({ sql: `UPDATE journal_entry SET status = 'draft' WHERE id = ?`, bind: [id] });
      db.exec({ sql: 'DELETE FROM journal_line WHERE entry_id = ?', bind: [id] });
      const payee = payeeFor(db, change.name);
      db.exec({
        sql: 'UPDATE journal_entry SET date = ?, ref = ?, name = ?, payee_id = ?, memo = ? WHERE id = ?',
        bind: [
          change.date,
          change.ref?.trim() || null,
          payee?.name ?? null,
          payee?.id ?? null,
          change.memo?.trim() || null,
          id,
        ],
      });
      writeLines(db, id, lines);
      postDraft(db, id);
      relink(db, links, id);
    }),
  );
}

/**
 * Delete a posted entry, where the company allows it (GL-6 off). Its bank
 * transactions go back to review and its attachments are removed.
 */
export function deleteEntry(db: Database, id: number, opts: PostOptions = {}): void {
  inSavepoint(db, 'delete_entry', () =>
    withOverride(db, opts.closingOverride, () => {
      requirePosted(db, id);
      db.exec({ sql: `UPDATE journal_entry SET status = 'draft' WHERE id = ?`, bind: [id] });
      db.exec({ sql: 'DELETE FROM journal_line WHERE entry_id = ?', bind: [id] });
      db.exec({
        sql: `DELETE FROM attachment WHERE entity = 'journal_entry' AND entity_id = ?`,
        bind: [String(id)],
      });
      db.exec({ sql: 'DELETE FROM journal_entry WHERE id = ?', bind: [id] });
    }),
  );
}

/**
 * Correct a posted entry the way GL-6 allows everywhere: void it and post the
 * corrected copy, from the same source. Bank transactions follow it when it
 * still fits them, and attachments move to it. Returns the new entry's id.
 */
export function correctEntry(
  db: Database,
  id: number,
  change: EntryChange,
  opts: PostOptions = {},
): number {
  return inSavepoint(db, 'correct_entry', () => {
    requirePosted(db, id);
    const source = db.selectObjects(
      'SELECT source_type, source_id FROM journal_entry WHERE id = ?',
      [id],
    )[0]!;
    const links = bankLinks(db, id);
    voidEntry(db, id, 'Corrected', opts);
    const newId = postEntry(
      db,
      {
        ...change,
        sourceType: String(source.source_type),
        sourceId: source.source_id === null ? null : String(source.source_id),
      },
      opts,
    );
    relink(db, links, newId);
    // Receipts belong to the transaction, so they move to the corrected copy
    db.exec({
      sql: `UPDATE attachment SET entity_id = ? WHERE entity = 'journal_entry' AND entity_id = ?`,
      bind: [String(newId), String(id)],
    });
    return newId;
  });
}

/** Void a posted entry (GL-6): its lines stay, and reports leave it out. */
export function voidEntry(
  db: Database,
  id: number,
  reason: string | null,
  opts: PostOptions = {},
): void {
  inSavepoint(db, 'void_entry', () =>
    withOverride(db, opts.closingOverride, () => {
      const status = db.selectValue('SELECT status FROM journal_entry WHERE id = ?', [id]);
      if (status !== 'posted') {
        throw new LedgerRuleError(
          status === 'void' ? 'This entry is already void.' : 'Only posted entries can be voided.',
        );
      }
      db.exec({
        sql: `UPDATE journal_entry SET status = 'void', voided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), void_reason = ?
              WHERE id = ?`,
        bind: [reason?.trim() || null, id],
      });
    }),
  );
}
