// The one posting path (CLAUDE.md rule 4). Modules never write ledger rows
// themselves: they call postEntry(), which writes a draft and its lines and
// then posts it, all in one savepoint. The schema's triggers check the balance
// (GL-3), the closing date (PC-1), inactive accounts (GL-7) and the cash-basis
// rule (GL-8) whatever the caller does; validateEntry() just says it nicely first.

import { MAX_CENTS, type Cents } from '../shared/money';
import { LedgerRuleError } from '../worker/errors';
import type { Database } from '../worker/sqlite';
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
  /** Payee, customer or vendor (MG-3) */
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

/** Post a balanced entry. Returns the new entry's id. */
export function postEntry(db: Database, input: EntryInput, opts: PostOptions = {}): number {
  const problems = validateEntry(input);
  if (problems.length) throw new LedgerRuleError(problems.join(' '));
  const lines = input.lines.filter((l) => l.debit !== 0 || l.credit !== 0);
  return inSavepoint(db, 'post_entry', () =>
    withOverride(db, opts.closingOverride, () => {
      const id = Number(
        db.selectValue(
          `INSERT INTO journal_entry (company_id, date, ref, name, memo, source_type, source_id)
           VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            input.date,
            input.ref?.trim() || null,
            input.name?.trim() || null,
            input.memo?.trim() || null,
            input.sourceType,
            input.sourceId ?? null,
          ],
        ),
      );
      const insert = db.prepare(
        `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit, credit, memo, name)
         VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        lines.forEach((l, i) =>
          insert
            .bind([
              id,
              i + 1,
              l.accountId,
              l.debit,
              l.credit,
              l.memo?.trim() || null,
              l.name?.trim() || null,
            ])
            .stepReset(),
        );
      } finally {
        insert.finalize();
      }
      db.exec({
        sql: `UPDATE journal_entry SET status = 'posted', posted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        bind: [id],
      });
      return id;
    }),
  );
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
