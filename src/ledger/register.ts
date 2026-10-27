// The transactions register (GL-9): every income and expense, or every entry,
// in date order with filters and totals, and the plain "paid from / deposited
// to, category, amount" shape the quick add and quick edit forms work in.

import type { AccountType } from '../shared/accounts';
import type { Cents } from '../shared/money';
import { LedgerRuleError } from '../worker/errors';
import type { Database } from '../worker/sqlite';
import { accountFullNames } from './accounts';
import type { EntryChange } from './postEntry';

export interface RegisterQuery {
  from?: string | null;
  to?: string | null;
  /** Entries with a line in this account */
  accountId?: string | null;
  /** 'pl': entries touching income or expense accounts (default); 'all': every entry */
  scope?: 'pl' | 'all';
  /** Matches ref, name or memo */
  search?: string;
  includeVoid?: boolean;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/** An entry as money out of (expense) or into (income) one account, split over categories. */
export interface SimpleEntry {
  kind: 'expense' | 'income';
  /** Paid from, or deposited to */
  moneyAccountId: string;
  lines: { accountId: string; amount: Cents; memo: string | null }[];
}

export interface RegisterRow {
  id: number;
  date: string;
  ref: string | null;
  name: string | null;
  memo: string | null;
  sourceType: string;
  status: 'posted' | 'void';
  /** Bank, card and other balance sheet accounts */
  accounts: string;
  /** Income, expense and equity accounts */
  categories: string;
  income: Cents;
  expense: Cents;
  attachments: number;
  /** The quick form's shape, when the entry has one */
  simple: SimpleEntry | null;
}

export interface RegisterResult {
  rows: RegisterRow[];
  /** All matching entries, beyond this page */
  count: number;
  /** Over all matching posted entries */
  totals: { income: Cents; expense: Cents };
}

interface Line {
  entryId: number;
  accountId: string;
  type: AccountType;
  debit: Cents;
  credit: Cents;
  memo: string | null;
}

const MONEY_TYPES: AccountType[] = ['asset', 'liability'];

/**
 * The entry as "paid from / deposited to" one account and category lines on
 * the other side, when it has exactly one line on one side. With one line on
 * each side, the balance sheet account is the money account.
 */
export function simpleShape(lines: Line[]): SimpleEntry | null {
  const debits = lines.filter((l) => l.debit > 0);
  const credits = lines.filter((l) => l.credit > 0);
  let money: Line | undefined;
  if (debits.length === 1 && credits.length === 1) {
    const [d, c] = [debits[0]!, credits[0]!];
    money = MONEY_TYPES.includes(c.type) || !MONEY_TYPES.includes(d.type) ? c : d;
  } else if (credits.length === 1 && debits.length > 1) money = credits[0];
  else if (debits.length === 1 && credits.length > 1) money = debits[0];
  if (!money) return null;
  const kind = money.credit > 0 ? 'expense' : 'income';
  return {
    kind,
    moneyAccountId: money.accountId,
    lines: lines
      .filter((l) => l !== money)
      .map((l) => ({
        accountId: l.accountId,
        amount: kind === 'expense' ? l.debit : l.credit,
        memo: l.memo,
      })),
  };
}

/** The entry lines for a quick form: the money line, then the categories. */
export function simpleToEntry(s: SimpleEntry, head: Omit<EntryChange, 'lines'>): EntryChange {
  const lines = s.lines.filter((l) => l.accountId || l.amount);
  if (!s.moneyAccountId)
    throw new LedgerRuleError(
      `Choose the account it was ${s.kind === 'expense' ? 'paid from' : 'deposited to'}.`,
    );
  if (lines.length === 0) throw new LedgerRuleError('Choose a category.');
  for (const l of lines) {
    if (!l.accountId) throw new LedgerRuleError('Choose a category for each line.');
    if (l.accountId === s.moneyAccountId)
      throw new LedgerRuleError(
        'A category can’t be the account it was paid from or deposited to.',
      );
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0)
      throw new LedgerRuleError('Each line needs an amount above zero.');
  }
  const total = lines.reduce((t, l) => t + l.amount, 0);
  const out = s.kind === 'expense';
  return {
    ...head,
    lines: [
      { accountId: s.moneyAccountId, debit: out ? 0 : total, credit: out ? total : 0 },
      ...lines.map((l) => ({
        accountId: l.accountId,
        debit: out ? l.amount : 0,
        credit: out ? 0 : l.amount,
        memo: l.memo,
      })),
    ],
  };
}

function where(q: RegisterQuery): { sql: string; bind: (string | number)[] } {
  const parts = [q.includeVoid ? `e.status IN ('posted', 'void')` : `e.status = 'posted'`];
  const bind: (string | number)[] = [];
  if (q.from) {
    parts.push('e.date >= ?');
    bind.push(q.from);
  }
  if (q.to) {
    parts.push('e.date <= ?');
    bind.push(q.to);
  }
  if ((q.scope ?? 'pl') === 'pl') {
    parts.push(`EXISTS (SELECT 1 FROM journal_line l JOIN account a ON a.id = l.account_id
                        WHERE l.entry_id = e.id AND a.type IN ('income', 'expense'))`);
  }
  if (q.accountId) {
    parts.push(
      'EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = e.id AND l.account_id = ?)',
    );
    bind.push(q.accountId);
  }
  if (q.search?.trim()) {
    parts.push(
      `(e.ref LIKE ? ESCAPE '\\' OR e.name LIKE ? ESCAPE '\\' OR e.memo LIKE ? ESCAPE '\\')`,
    );
    const like = `%${q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    bind.push(like, like, like);
  }
  return { sql: parts.join(' AND '), bind };
}

export function register(db: Database, q: RegisterQuery = {}): RegisterResult {
  const w = where(q);
  const dir = q.order === 'asc' ? 'ASC' : 'DESC';
  const entries = db.selectObjects(
    `SELECT e.id, e.date, e.ref, e.name, e.memo, e.source_type, e.status,
            (SELECT count(*) FROM attachment WHERE entity = 'journal_entry' AND entity_id = CAST(e.id AS TEXT)) AS attachments
     FROM journal_entry e WHERE ${w.sql}
     ORDER BY e.date ${dir}, e.id ${dir} LIMIT ? OFFSET ?`,
    [...w.bind, q.limit ?? 200, q.offset ?? 0],
  );
  const ids = entries.map((e) => Number(e.id));
  const lines = new Map<number, Line[]>();
  if (ids.length) {
    for (const r of db.selectObjects(
      `SELECT l.entry_id, l.account_id, a.type, l.debit, l.credit, l.memo FROM journal_line l
       JOIN account a ON a.id = l.account_id
       WHERE l.entry_id IN (${ids.map(() => '?').join(', ')}) ORDER BY l.entry_id, l.line_no`,
      ids,
    )) {
      const id = Number(r.entry_id);
      if (!lines.has(id)) lines.set(id, []);
      lines.get(id)!.push({
        entryId: id,
        accountId: String(r.account_id),
        type: r.type as AccountType,
        debit: Number(r.debit),
        credit: Number(r.credit),
        memo: r.memo === null ? null : String(r.memo),
      });
    }
  }
  const names = accountFullNames(db);
  const join = (ls: Line[]) =>
    [...new Set(ls.map((l) => names.get(l.accountId) ?? '?'))].join(', ');
  const rows = entries.map((e): RegisterRow => {
    const ls = lines.get(Number(e.id)) ?? [];
    const sum = (type: AccountType, f: (l: Line) => number) =>
      ls.filter((l) => l.type === type).reduce((t, l) => t + f(l), 0);
    return {
      id: Number(e.id),
      date: String(e.date),
      ref: e.ref === null ? null : String(e.ref),
      name: e.name === null ? null : String(e.name),
      memo: e.memo === null ? null : String(e.memo),
      sourceType: String(e.source_type),
      status: e.status as 'posted' | 'void',
      accounts: join(ls.filter((l) => MONEY_TYPES.includes(l.type))),
      categories: join(ls.filter((l) => !MONEY_TYPES.includes(l.type))),
      income: sum('income', (l) => l.credit - l.debit),
      expense: sum('expense', (l) => l.debit - l.credit),
      attachments: Number(e.attachments),
      simple: simpleShape(ls),
    };
  });
  // SQLite refuses an empty bind list on a statement without parameters
  const bind = w.bind.length ? w.bind : undefined;
  const count = Number(db.selectValue(`SELECT count(*) FROM journal_entry e WHERE ${w.sql}`, bind));
  const totals = db.selectObjects(
    `SELECT coalesce(sum(CASE WHEN a.type = 'income' THEN l.credit - l.debit END), 0) AS income,
            coalesce(sum(CASE WHEN a.type = 'expense' THEN l.debit - l.credit END), 0) AS expense
     FROM journal_line l JOIN account a ON a.id = l.account_id
     WHERE l.entry_id IN (SELECT e.id FROM journal_entry e WHERE ${w.sql} AND e.status = 'posted')`,
    bind,
  )[0]!;
  return {
    rows,
    count,
    totals: { income: Number(totals.income), expense: Number(totals.expense) },
  };
}
