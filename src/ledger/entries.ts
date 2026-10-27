// Reading journal entries for the journal list and entry view.

import type { Cents } from '../shared/money';
import type { Database } from '../worker/sqlite';
import { accountFullNames } from './accounts';

export interface EntrySummary {
  id: number;
  date: string;
  ref: string | null;
  name: string | null;
  memo: string | null;
  sourceType: string;
  status: 'posted' | 'void';
  amount: Cents;
  attachments: number;
}

export interface EntryLine {
  lineNo: number;
  accountId: string;
  account: string;
  debit: Cents;
  credit: Cents;
  memo: string | null;
  name: string | null;
}

export interface EntryDetail extends EntrySummary {
  postedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  lines: EntryLine[];
}

export interface EntryQuery {
  limit?: number;
  /** Continue after this entry (newest first). */
  after?: { date: string; id: number };
  includeVoid?: boolean;
  /** Matches ref, name or memo. */
  search?: string;
  accountId?: string;
}

const summary = (r: Record<string, unknown>): EntrySummary => ({
  id: Number(r.id),
  date: String(r.date),
  ref: r.ref === null ? null : String(r.ref),
  name: r.name === null ? null : String(r.name),
  memo: r.memo === null ? null : String(r.memo),
  sourceType: String(r.source_type),
  status: r.status as 'posted' | 'void',
  amount: Number(r.amount),
  attachments: Number(r.attachments ?? 0),
});

const SELECT = `
  SELECT e.id, e.date, e.ref, e.name, e.memo, e.source_type, e.status, e.posted_at, e.voided_at, e.void_reason,
         (SELECT coalesce(sum(debit), 0) FROM journal_line WHERE entry_id = e.id) AS amount,
         (SELECT count(*) FROM attachment WHERE entity = 'journal_entry' AND entity_id = CAST(e.id AS TEXT)) AS attachments
  FROM journal_entry e`;

/** Posted (and optionally void) entries, newest first. Drafts never leave postEntry(). */
export function listEntries(db: Database, q: EntryQuery = {}): EntrySummary[] {
  const where = [q.includeVoid ? `e.status IN ('posted', 'void')` : `e.status = 'posted'`];
  const bind: (string | number)[] = [];
  if (q.after) {
    where.push('(e.date < ? OR (e.date = ? AND e.id < ?))');
    bind.push(q.after.date, q.after.date, q.after.id);
  }
  if (q.search?.trim()) {
    where.push(
      `(e.ref LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\' OR e.memo LIKE ? ESCAPE '\\')`,
    );
    const like = `%${q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    bind.push(like, like, like);
  }
  if (q.accountId) {
    where.push(
      'EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = e.id AND l.account_id = ?)',
    );
    bind.push(q.accountId);
  }
  bind.push(Math.min(q.limit ?? 100, 500));
  return db
    .selectObjects(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC LIMIT ?`,
      bind,
    )
    .map(summary);
}

export function getEntry(db: Database, id: number): EntryDetail | null {
  const row = db.selectObjects(`${SELECT} WHERE e.id = ? AND e.status <> 'draft'`, [id])[0];
  if (!row) return null;
  const names = accountFullNames(db);
  return {
    ...summary(row),
    postedAt: row.posted_at === null ? null : String(row.posted_at),
    voidedAt: row.voided_at === null ? null : String(row.voided_at),
    voidReason: row.void_reason === null ? null : String(row.void_reason),
    lines: db
      .selectObjects(
        'SELECT line_no, account_id, debit, credit, memo, name FROM journal_line WHERE entry_id = ? ORDER BY line_no',
        [id],
      )
      .map((l) => ({
        lineNo: Number(l.line_no),
        accountId: String(l.account_id),
        account: names.get(String(l.account_id)) ?? '?',
        debit: Number(l.debit),
        credit: Number(l.credit),
        memo: l.memo === null ? null : String(l.memo),
        name: l.name === null ? null : String(l.name),
      })),
  };
}
