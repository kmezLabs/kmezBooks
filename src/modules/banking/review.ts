// The review queue (BK-3, BK-4, BK-5, BK-6, BK-9). Each imported transaction
// waits here until the owner categorizes it (a new entry through postEntry()),
// matches it to an entry already in the books, or excludes it. Suggestions
// are worked out when the queue is read, so a new rule shows at once:
// - a rule (BK-5), or failing that how the same payee was categorized last time
// - entries already in the books that move the same amount (BK-4), including
//   migrated QuickBooks history, so nothing is entered twice (BK-6)
// - the other side of a transfer waiting in another account's queue (BK-9)

import type { Cents } from '../../shared/money';
import { accountFullNames } from '../../ledger/accounts';
import { postEntry, voidEntry, type PostOptions } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';
import { firstRule, listRules, type RuleRow } from './rules';

/** source_type of entries posted from the review queue; source_id is the bank_txn id. */
export const BANK_SOURCE = 'bank';

/** How far apart an entry's date and the bank's date may be for a match (BK-4). */
export const MATCH_DAYS = 10;
/** How far apart the two sides of a transfer may be (BK-9). */
export const TRANSFER_DAYS = 5;

export type TxnStatus = 'new' | 'posted' | 'matched' | 'excluded';

export interface BankTxn {
  id: number;
  accountId: string;
  date: string;
  amount: Cents;
  payee: string | null;
  memo: string | null;
  checkNo: string | null;
  type: string | null;
  status: TxnStatus;
  entryId: number | null;
  duplicateOf: number | null;
}

export type Suggestion =
  | {
      source: 'rule';
      ruleId: string;
      ruleName: string;
      categoryId: string;
      payee: string | null;
      memo: string | null;
    }
  | { source: 'history'; categoryId: string; payee: string | null };

export interface MatchCandidate {
  entryId: number;
  date: string;
  ref: string | null;
  name: string | null;
  memo: string | null;
  sourceType: string;
  /** The entry's other accounts, for recognising it */
  accounts: string;
}

export interface TransferCandidate {
  txnId: number;
  accountId: string;
  account: string;
  date: string;
}

export interface QueueItem extends BankTxn {
  suggestion: Suggestion | null;
  matches: MatchCandidate[];
  transfer: TransferCandidate | null;
  /** Probably already in the books: a flagged bank id, or a migrated entry with the same amount */
  possibleDuplicate: boolean;
  /** For reviewed items: the entry's other accounts */
  entryAccounts: string | null;
}

const txn = (r: Record<string, unknown>): BankTxn => ({
  id: Number(r.id),
  accountId: String(r.account_id),
  date: String(r.date),
  amount: Number(r.amount),
  payee: r.payee === null ? null : String(r.payee),
  memo: r.memo === null ? null : String(r.memo),
  checkNo: r.check_no === null ? null : String(r.check_no),
  type: r.trn_type === null ? null : String(r.trn_type),
  status: r.status as TxnStatus,
  entryId: r.entry_id === null ? null : Number(r.entry_id),
  duplicateOf: r.duplicate_of === null ? null : Number(r.duplicate_of),
});

export function getTxn(db: Database, id: number): BankTxn {
  const r = db.selectObjects('SELECT * FROM bank_txn WHERE id = ?', [id])[0];
  if (!r) throw new LedgerRuleError('That transaction is no longer in the review.');
  return txn(r);
}

/** The other accounts of an entry, as "Rent, Utilities". */
function otherAccounts(
  db: Database,
  names: Map<string, string>,
  entryId: number,
  accountId: string,
): string {
  return db
    .selectArrays(
      `SELECT DISTINCT account_id FROM journal_line WHERE entry_id = ? AND account_id <> ? ORDER BY line_no`,
      [entryId, accountId],
    )
    .map((r) => names.get(String(r[0])) ?? '?')
    .join(', ');
}

/** Entries already in the books that move this amount through this account near this date (BK-4). */
export function matchCandidates(
  db: Database,
  t: BankTxn,
  names = accountFullNames(db),
): MatchCandidate[] {
  return db
    .selectObjects(
      `SELECT e.id, e.date, e.ref, e.name, e.memo, e.source_type
       FROM journal_entry e
       WHERE e.status = 'posted'
         AND e.date BETWEEN date(:date, '-${MATCH_DAYS} days') AND date(:date, '+${MATCH_DAYS} days')
         AND (SELECT sum(debit - credit) FROM journal_line WHERE entry_id = e.id AND account_id = :account) = :amount
         AND NOT EXISTS (SELECT 1 FROM bank_txn b WHERE b.entry_id = e.id AND b.account_id = :account)
       ORDER BY (e.ref IS NOT NULL AND e.ref = :check) DESC,
                abs(julianday(e.date) - julianday(:date)), e.id
       LIMIT 5`,
      { ':date': t.date, ':account': t.accountId, ':amount': t.amount, ':check': t.checkNo },
    )
    .map((r) => ({
      entryId: Number(r.id),
      date: String(r.date),
      ref: r.ref === null ? null : String(r.ref),
      name: r.name === null ? null : String(r.name),
      memo: r.memo === null ? null : String(r.memo),
      sourceType: String(r.source_type),
      accounts: otherAccounts(db, names, Number(r.id), t.accountId),
    }));
}

/** The other side of a transfer, waiting in another account's queue (BK-9). */
function transferCandidate(
  db: Database,
  t: BankTxn,
  names: Map<string, string>,
): TransferCandidate | null {
  const r = db.selectObjects(
    `SELECT id, account_id, date FROM bank_txn
     WHERE status = 'new' AND account_id <> :account AND amount = :amount
       AND date BETWEEN date(:date, '-${TRANSFER_DAYS} days') AND date(:date, '+${TRANSFER_DAYS} days')
     ORDER BY abs(julianday(date) - julianday(:date)), id LIMIT 1`,
    { ':account': t.accountId, ':amount': -t.amount, ':date': t.date },
  )[0];
  return r
    ? {
        txnId: Number(r.id),
        accountId: String(r.account_id),
        account: names.get(String(r.account_id)) ?? '?',
        date: String(r.date),
      }
    : null;
}

/** How this payee was categorized the last time, if that was a single category. */
function historySuggestion(db: Database, t: BankTxn): Suggestion | null {
  if (!t.payee) return null;
  const last = db.selectObjects(
    `SELECT b.entry_id, e.name FROM bank_txn b JOIN journal_entry e ON e.id = b.entry_id
     WHERE b.account_id = ? AND b.status = 'posted' AND b.payee = ? COLLATE NOCASE AND e.source_type = ?
     ORDER BY b.date DESC, b.id DESC LIMIT 1`,
    [t.accountId, t.payee, BANK_SOURCE],
  )[0];
  if (!last) return null;
  const others = db.selectArrays(
    `SELECT DISTINCT l.account_id FROM journal_line l JOIN account a ON a.id = l.account_id
     WHERE l.entry_id = ? AND l.account_id <> ? AND a.active = 1`,
    [Number(last.entry_id), t.accountId],
  );
  if (others.length !== 1) return null;
  return {
    source: 'history',
    categoryId: String(others[0]![0]),
    payee: last.name === null ? null : String(last.name),
  };
}

function suggest(db: Database, t: BankTxn, rules: RuleRow[]): Suggestion | null {
  const rule = firstRule(rules, t);
  if (rule) {
    return {
      source: 'rule',
      ruleId: rule.id,
      ruleName: rule.name,
      categoryId: rule.categoryId,
      payee: rule.payee,
      memo: rule.memo,
    };
  }
  return historySuggestion(db, t);
}

export type QueueView = 'new' | 'excluded' | 'reviewed';

/** One account's queue, newest first, with suggestions for transactions waiting for review. */
export function listQueue(
  db: Database,
  accountId: string,
  view: QueueView = 'new',
  limit = 500,
): QueueItem[] {
  const statuses =
    view === 'new' ? `('new')` : view === 'excluded' ? `('excluded')` : `('posted', 'matched')`;
  const rows = db
    .selectObjects(
      `SELECT * FROM bank_txn WHERE account_id = ? AND status IN ${statuses} ORDER BY date DESC, id DESC LIMIT ?`,
      [accountId, limit],
    )
    .map(txn);
  const names = accountFullNames(db);
  const rules = view === 'new' ? listRules(db).filter((r) => r.active) : [];
  return rows.map((t) => {
    if (t.status !== 'new') {
      return {
        ...t,
        suggestion: null,
        matches: [],
        transfer: null,
        possibleDuplicate: false,
        entryAccounts: t.entryId === null ? null : otherAccounts(db, names, t.entryId, t.accountId),
      };
    }
    const matches = matchCandidates(db, t, names);
    return {
      ...t,
      suggestion: suggest(db, t, rules),
      matches,
      transfer: matches.length ? null : transferCandidate(db, t, names),
      possibleDuplicate:
        t.duplicateOf !== null || matches.some((m) => m.sourceType === 'qbo_migration'),
      entryAccounts: null,
    };
  });
}

/** How many transactions wait for review in each account. */
export function queueCounts(db: Database): Record<string, number> {
  return Object.fromEntries(
    db
      .selectArrays(
        `SELECT account_id, count(*) FROM bank_txn WHERE status = 'new' GROUP BY account_id`,
      )
      .map((r) => [String(r[0]), Number(r[1])]),
  );
}

// ---- reviewing ----

export interface CategoryLine {
  accountId: string;
  /** The part of the transaction's amount, always positive */
  amount: Cents;
  memo?: string | null;
}

export interface CategorizeInput {
  /** Payee on the entry; the bank's payee if left out */
  payee?: string | null;
  memo?: string | null;
  /** One line to categorize, several to split; they add up to the transaction's amount */
  lines: CategoryLine[];
}

function setReviewed(db: Database, t: BankTxn, status: 'posted' | 'matched', entryId: number) {
  db.exec({
    sql: `UPDATE bank_txn SET status = ?, entry_id = ? WHERE id = ? AND status = 'new'`,
    bind: [status, entryId, t.id],
  });
  if (db.changes() !== 1) throw new LedgerRuleError('That transaction has already been reviewed.');
}

function requireNew(t: BankTxn) {
  if (t.status !== 'new') throw new LedgerRuleError('That transaction has already been reviewed.');
}

/**
 * Categorize (or split) a transaction: post an entry for it through the one
 * posting path, then let the other side of a transfer match it (BK-9).
 * Returns the new entry's id.
 */
export function categorize(
  db: Database,
  id: number,
  input: CategorizeInput,
  opts: PostOptions = {},
): number {
  return inSavepoint(db, 'bank_categorize', () => {
    const t = getTxn(db, id);
    requireNew(t);
    const lines = input.lines.filter((l) => l.accountId || l.amount);
    if (lines.length === 0) throw new LedgerRuleError('Choose a category.');
    for (const l of lines) {
      if (!l.accountId) throw new LedgerRuleError('Choose a category for each line.');
      if (l.accountId === t.accountId) {
        throw new LedgerRuleError('A transaction can’t be categorized to its own account.');
      }
      if (!Number.isSafeInteger(l.amount) || l.amount <= 0) {
        throw new LedgerRuleError('Each line needs an amount above zero.');
      }
    }
    const total = lines.reduce((s, l) => s + BigInt(l.amount), 0n);
    if (total !== BigInt(Math.abs(t.amount))) {
      throw new LedgerRuleError('The lines must add up to the transaction’s amount.');
    }
    const inflow = t.amount > 0;
    const entryId = postEntry(
      db,
      {
        date: t.date,
        ref: t.checkNo,
        name: input.payee === undefined ? t.payee : input.payee,
        memo: input.memo === undefined ? t.memo : input.memo,
        sourceType: BANK_SOURCE,
        sourceId: String(t.id),
        lines: [
          { accountId: t.accountId, debit: inflow ? t.amount : 0, credit: inflow ? 0 : -t.amount },
          ...lines.map((l) => ({
            accountId: l.accountId,
            debit: inflow ? 0 : l.amount,
            credit: inflow ? l.amount : 0,
            memo: l.memo ?? null,
          })),
        ],
      },
      opts,
    );
    setReviewed(db, t, 'posted', entryId);
    matchOtherSide(db, entryId, t);
    return entryId;
  });
}

/**
 * After a transfer is entered from one account, its other side waiting in the
 * other account's queue is matched to the same entry (BK-9): exactly one
 * waiting transaction with the opposite amount, close in date.
 */
function matchOtherSide(db: Database, entryId: number, t: BankTxn): number {
  let matched = 0;
  const others = db.selectArrays(
    `SELECT account_id, sum(debit - credit) FROM journal_line WHERE entry_id = ? AND account_id <> ? GROUP BY account_id`,
    [entryId, t.accountId],
  );
  for (const [account, net] of others) {
    const candidates = db.selectArrays(
      `SELECT id FROM bank_txn WHERE account_id = ? AND status = 'new' AND amount = ?
         AND date BETWEEN date(?, '-${TRANSFER_DAYS} days') AND date(?, '+${TRANSFER_DAYS} days')`,
      [String(account), Number(net), t.date, t.date],
    );
    if (candidates.length === 1) {
      setReviewed(db, getTxn(db, Number(candidates[0]![0])), 'matched', entryId);
      matched++;
    }
  }
  return matched;
}

/** Match a transaction to an entry already in the books (BK-4); the schema checks the amount. */
export function match(db: Database, id: number, entryId: number): void {
  inSavepoint(db, 'bank_match', () => {
    const t = getTxn(db, id);
    requireNew(t);
    setReviewed(db, t, 'matched', entryId);
  });
}

/** Record a transfer between two of the owner's accounts and match both sides (BK-9). */
export function transfer(
  db: Database,
  id: number,
  otherTxnId: number,
  opts: PostOptions = {},
): number {
  return inSavepoint(db, 'bank_transfer', () => {
    const t = getTxn(db, id);
    const other = getTxn(db, otherTxnId);
    requireNew(t);
    requireNew(other);
    if (other.amount !== -t.amount || other.accountId === t.accountId) {
      throw new LedgerRuleError(
        'The two sides of a transfer must be opposite amounts in two accounts.',
      );
    }
    const entryId = categorize(
      db,
      id,
      {
        memo: t.memo ?? 'Transfer',
        lines: [{ accountId: other.accountId, amount: Math.abs(t.amount) }],
      },
      opts,
    );
    // Usually matched already; not when another waiting transaction looked the same
    if (getTxn(db, otherTxnId).status === 'new') setReviewed(db, other, 'matched', entryId);
    return entryId;
  });
}

export function exclude(db: Database, id: number): void {
  inSavepoint(db, 'bank_exclude', () => {
    requireNew(getTxn(db, id));
    db.exec({ sql: `UPDATE bank_txn SET status = 'excluded' WHERE id = ?`, bind: [id] });
  });
}

/** Put an excluded transaction back in the queue. */
export function restore(db: Database, id: number): void {
  inSavepoint(db, 'bank_restore', () => {
    if (getTxn(db, id).status !== 'excluded')
      throw new LedgerRuleError('That transaction isn’t excluded.');
    db.exec({ sql: `UPDATE bank_txn SET status = 'new' WHERE id = ?`, bind: [id] });
  });
}

/**
 * Send a reviewed transaction back to the queue. An entry the review posted is
 * voided (which also returns a transfer's other side, matched to it); a match
 * is just undone. Returns the voided entry's id, if any.
 */
export function undo(db: Database, id: number, opts: PostOptions = {}): number | null {
  return inSavepoint(db, 'bank_undo', () => {
    const t = getTxn(db, id);
    if (t.status === 'matched' || t.status === 'excluded') {
      db.exec({
        sql: `UPDATE bank_txn SET status = 'new', entry_id = NULL WHERE id = ?`,
        bind: [id],
      });
      return null;
    }
    if (t.status !== 'posted' || t.entryId === null)
      throw new LedgerRuleError('That transaction is still waiting for review.');
    const source = db.selectObjects(
      'SELECT source_type, source_id FROM journal_entry WHERE id = ?',
      [t.entryId],
    )[0];
    if (source?.source_type === BANK_SOURCE && source.source_id === String(t.id)) {
      voidEntry(db, t.entryId, 'Undone in bank review', opts);
      return t.entryId;
    }
    db.exec({
      sql: `UPDATE bank_txn SET status = 'new', entry_id = NULL WHERE id = ?`,
      bind: [id],
    });
    return null;
  });
}

// ---- after an import ----

export interface AutoResult {
  /** Posted by a rule set to post automatically (BK-5) */
  autoPosted: number;
  /** Matched to a transfer already entered from the other account (BK-9) */
  autoMatched: number;
  /** The entries the rules posted, to announce as ledger events */
  postedEntryIds: number[];
}

/**
 * Right after an import: match each new transaction to a transfer already
 * entered from the other account (BK-9), and post the ones a rule says to
 * post automatically (BK-5). Anything that might already be in the books, is
 * in a closed period, or that a rule can't post, stays in the queue.
 */
export function autoProcess(db: Database, ids: number[]): AutoResult {
  const result: AutoResult = { autoPosted: 0, autoMatched: 0, postedEntryIds: [] };
  const rules = listRules(db).filter((r) => r.active);
  for (const id of ids) {
    const t = getTxn(db, id);
    if (t.status !== 'new') continue;
    const candidates = matchCandidates(db, t);
    const transfers = candidates.filter((m) => m.sourceType === BANK_SOURCE);
    if (transfers.length === 1 && isTransferEntry(db, transfers[0]!.entryId, t.accountId)) {
      match(db, id, transfers[0]!.entryId);
      result.autoMatched++;
      continue;
    }
    // Possibly in the books already: the owner decides
    if (candidates.length > 0) continue;
    const rule = firstRule(rules, t);
    if (rule?.autoPost) {
      try {
        const entryId = categorize(db, id, {
          payee: rule.payee ?? t.payee,
          memo: rule.memo ?? t.memo,
          lines: [{ accountId: rule.categoryId, amount: Math.abs(t.amount) }],
        });
        result.postedEntryIds.push(entryId);
        result.autoPosted++;
      } catch {
        // e.g. a closed period or an inactive category: it waits for the owner
      }
    }
  }
  return result;
}

/** An entry posted from another account's review, whose bank line in that account accounts for it. */
function isTransferEntry(db: Database, entryId: number, accountId: string): boolean {
  return (
    Number(
      db.selectValue(`SELECT count(*) FROM bank_txn WHERE entry_id = ? AND account_id <> ?`, [
        entryId,
        accountId,
      ]),
    ) > 0
  );
}

/**
 * Post waiting transactions as their suggested category says (BK-3, BK-5).
 * Ones that may already be in the books (a matching entry) are left for the
 * owner, so a bulk accept never enters anything twice. Returns the new entries.
 */
export function acceptSuggestions(db: Database, ids: number[], opts: PostOptions = {}): number[] {
  return inSavepoint(db, 'bank_accept', () => {
    const rules = listRules(db).filter((r) => r.active);
    const posted: number[] = [];
    for (const id of ids) {
      const t = getTxn(db, id);
      if (t.status !== 'new' || matchCandidates(db, t).length > 0) continue;
      const s = suggest(db, t, rules);
      if (!s) continue;
      posted.push(
        categorize(
          db,
          id,
          {
            payee: s.payee ?? t.payee,
            memo: s.source === 'rule' ? (s.memo ?? t.memo) : t.memo,
            lines: [{ accountId: s.categoryId, amount: Math.abs(t.amount) }],
          },
          opts,
        ),
      );
    }
    return posted;
  });
}
