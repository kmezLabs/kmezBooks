// The transactions register (GL-9): every income and expense, or every entry,
// in date order with filters and totals, and the plain "paid from / deposited
// to, category, amount" shape the quick add and quick edit forms work in. One
// account's register (GL-12) adds its running balance and what was reconciled;
// a transfer (GL-13) is the same shape between two money accounts.

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
  /** Entries naming this payee, on the entry or a line (GL-11) */
  payeeId?: string | null;
  includeVoid?: boolean;
  /**
   * desc: newest first. asc: oldest first, but the page is the latest `limit`
   * entries (after `offset` newer ones), so a register opens at its end.
   */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Add the balance of this account after each entry, as a bank register does */
  balanceAccountId?: string | null;
}

/**
 * An entry as money out of (expense) or into (income) one account, split over
 * categories; or a transfer (GL-13) from one money account to another, the
 * one line being the account it went to.
 */
export interface SimpleEntry {
  kind: 'expense' | 'income' | 'transfer';
  /** Paid from, deposited to, or transferred from */
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
  /** With a balance account: the entry's movement in it, debit minus credit */
  accountAmount: Cents | null;
  /** The balance account's debit-minus-credit balance after this entry; null for void ones */
  balance: Cents | null;
  /**
   * With a balance account: its line cleared in a finished reconciliation (R)
   * or in the one open now (C), as QuickBooks marks them (GL-12)
   */
  reconciled: 'R' | 'C' | null;
  /** With a balance account: the entry's other accounts, its category or where the money went */
  otherSide: string;
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
  // One money account to another: a transfer, from the credit to the debit
  const transfer =
    debits.length === 1 &&
    credits.length === 1 &&
    MONEY_TYPES.includes(debits[0]!.type) &&
    MONEY_TYPES.includes(credits[0]!.type);
  if (transfer) {
    const to = debits[0]!;
    return {
      kind: 'transfer',
      moneyAccountId: credits[0]!.accountId,
      lines: [{ accountId: to.accountId, amount: to.debit, memo: to.memo }],
    };
  }
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
  if (s.kind === 'transfer') {
    const to = lines[0];
    if (!s.moneyAccountId) throw new LedgerRuleError('Choose the account the money came from.');
    if (lines.length !== 1 || !to?.accountId)
      throw new LedgerRuleError('Choose the account the money went to.');
    if (to.accountId === s.moneyAccountId)
      throw new LedgerRuleError('A transfer goes between two different accounts.');
    if (!Number.isSafeInteger(to.amount) || to.amount <= 0)
      throw new LedgerRuleError('Enter an amount above zero.');
    return {
      ...head,
      lines: [
        { accountId: s.moneyAccountId, debit: 0, credit: to.amount },
        { accountId: to.accountId, debit: to.amount, credit: 0, memo: to.memo },
      ],
    };
  }
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
  if (q.payeeId) {
    parts.push(
      '(e.payee_id = ? OR EXISTS (SELECT 1 FROM journal_line l WHERE l.entry_id = e.id AND l.payee_id = ?))',
    );
    bind.push(q.payeeId, q.payeeId);
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

/**
 * The account's balance after each posted entry in rows, in date order: the
 * balance before the earliest, then each entry's movement in the account,
 * including entries a filter leaves out of the page.
 */
function runningBalances(
  db: Database,
  accountId: string,
  rows: { id: number; date: string; status: string }[],
) {
  const balances = new Map<number, Cents>();
  const posted = rows
    .filter((r) => r.status === 'posted')
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const first = posted[0];
  const last = posted.at(-1);
  if (!first || !last) return balances;
  let balance = Number(
    db.selectValue(
      `SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
       WHERE l.account_id = ? AND (e.date < ? OR (e.date = ? AND e.id < ?))`,
      [accountId, first.date, first.date, first.id],
    ),
  );
  for (const [id, net] of db.selectArrays(
    `SELECT e.id, sum(l.debit - l.credit) FROM journal_line l
     JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
     WHERE l.account_id = ?
       AND (e.date > ? OR (e.date = ? AND e.id >= ?))
       AND (e.date < ? OR (e.date = ? AND e.id <= ?))
     GROUP BY e.id ORDER BY e.date, e.id`,
    [accountId, first.date, first.date, first.id, last.date, last.date, last.id],
  )) {
    balance += Number(net);
    balances.set(Number(id), balance);
  }
  return balances;
}

export function register(db: Database, q: RegisterQuery = {}): RegisterResult {
  const w = where(q);
  // Oldest first shows the latest page too, so fetch newest first and turn it around
  const ascending = q.order === 'asc';
  const entries = db.selectObjects(
    `SELECT e.id, e.date, e.ref, e.name, e.memo, e.source_type, e.status,
            (SELECT count(*) FROM attachment WHERE entity = 'journal_entry' AND entity_id = CAST(e.id AS TEXT)) AS attachments
     FROM journal_entry e WHERE ${w.sql}
     ORDER BY e.date DESC, e.id DESC LIMIT ? OFFSET ?`,
    [...w.bind, q.limit ?? 200, q.offset ?? 0],
  );
  if (ascending) entries.reverse();
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
      accountAmount: q.balanceAccountId
        ? ls
            .filter((l) => l.accountId === q.balanceAccountId)
            .reduce((t, l) => t + l.debit - l.credit, 0)
        : null,
      balance: null,
      reconciled: null,
      otherSide: q.balanceAccountId
        ? join(ls.filter((l) => l.accountId !== q.balanceAccountId))
        : '',
    };
  });
  if (q.balanceAccountId) {
    const balances = runningBalances(db, q.balanceAccountId, rows);
    for (const r of rows) r.balance = balances.get(r.id) ?? null;
    // Finished beats open, should an entry have lines in both
    if (ids.length) {
      const marks = new Map<number, 'R' | 'C'>();
      for (const [entryId, status] of db.selectArrays(
        `SELECT l.entry_id, max(CASE WHEN c.status = 'done' THEN 2 ELSE 1 END)
         FROM journal_line l
         JOIN reconciled_line rl ON rl.line_id = l.id
         JOIN reconciliation c ON c.id = rl.reconciliation_id
         WHERE l.account_id = ? AND l.entry_id IN (${ids.map(() => '?').join(', ')})
         GROUP BY l.entry_id`,
        [q.balanceAccountId, ...ids],
      )) {
        marks.set(Number(entryId), Number(status) === 2 ? 'R' : 'C');
      }
      for (const r of rows) r.reconciled = marks.get(r.id) ?? null;
    }
  }
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

/** Which accounts each register shows (GL-12): banks with cash on hand, or cards. */
export const REGISTER_KINDS = {
  bank: ['bank', 'cash_on_hand'],
  card: ['credit_card'],
} as const;
export type RegisterKind = keyof typeof REGISTER_KINDS;

export interface MoneyAccount {
  id: string;
  name: string;
  detailType: string;
  active: boolean;
  /** Debit minus credit over posted entries; a card owes when it's negative */
  balance: Cents;
  /** The last finished reconciliation: its statement date and ending balance */
  reconciled: { date: string; balance: Cents } | null;
}

/**
 * The accounts a register switches between, by name: active ones, and
 * inactive ones that still hold a balance.
 */
export function moneyAccounts(db: Database, kind: RegisterKind): MoneyAccount[] {
  const types: readonly string[] = REGISTER_KINDS[kind];
  const names = accountFullNames(db);
  return db
    .selectObjects(
      `SELECT a.id, a.detail_type, a.active,
              (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_line l
               JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
               WHERE l.account_id = a.id) AS balance,
              (SELECT statement_date FROM reconciliation r WHERE r.account_id = a.id AND r.status = 'done'
               ORDER BY statement_date DESC LIMIT 1) AS reconciled_date,
              (SELECT ending_balance FROM reconciliation r WHERE r.account_id = a.id AND r.status = 'done'
               ORDER BY statement_date DESC LIMIT 1) AS reconciled_balance
       FROM account a WHERE a.detail_type IN (${types.map(() => '?').join(', ')})`,
      [...types],
    )
    .map((r) => ({
      id: String(r.id),
      name: names.get(String(r.id)) ?? '?',
      detailType: String(r.detail_type),
      active: r.active === 1,
      balance: Number(r.balance),
      reconciled:
        r.reconciled_date === null
          ? null
          : { date: String(r.reconciled_date), balance: Number(r.reconciled_balance) },
    }))
    .filter((a) => a.active || a.balance !== 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}
