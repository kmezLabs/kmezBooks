// The review queue (BK-3, BK-4, BK-5, BK-6, BK-9). Each imported transaction
// waits here until the owner categorizes it (a new entry through postEntry()),
// matches it to an entry already in the books, or excludes it. Suggestions
// are worked out when the queue is read, so a new rule shows at once:
// - a rule (BK-5), or failing that how the same payee was categorized last
//   time, deposits and payments apart, or failing that for a payment the
//   vendor's default category (AP-1)
// - entries already in the books that move the same amount (BK-4), including
//   migrated QuickBooks history, so nothing is entered twice (BK-6). QuickBooks
//   keeps the bank's own description in the memo of what came from its bank
//   feed, so an entry with this transaction's bank text is all but certain
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
  | { source: 'history'; categoryId: string; payee: string | null }
  | { source: 'vendor'; categoryId: string; payee: string };

export interface MatchCandidate {
  entryId: number;
  date: string;
  ref: string | null;
  name: string | null;
  memo: string | null;
  sourceType: string;
  /** The entry's other accounts, for recognising it */
  accounts: string;
  /**
   * How surely the bank's own text says it is this transaction: 2 the entry's
   * memo has the whole bank description, 1 the bank payee on the same day, 0 no
   */
  bankText: 0 | 1 | 2;
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
  /** The bank may have sent it twice: an earlier transaction has its bank id (BK-6) */
  possibleDuplicate: boolean;
  /** Already in the books from the QuickBooks history: match it, don't add it again (BK-6) */
  alreadyInBooks: boolean;
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

/** Upper case with single spaces, as QuickBooks and the bank space the same text differently. */
const plainText = (s: string | null) => (s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Bank text shorter than this ("CHECK", "DEPOSIT") says nothing about which transaction it is. */
const MIN_BANK_TEXT = 8;

/** How surely an entry's memo text shows it is this bank transaction (see MatchCandidate.bankText). */
export function bankTextScore(t: BankTxn, entryText: string | null, entryDate: string): 0 | 1 | 2 {
  const text = plainText(entryText);
  if (!text) return 0;
  // Capital One repeats the payee as the memo; QuickBooks keeps it once
  const whole = [...new Set([plainText(t.payee), plainText(t.memo)])].filter(Boolean).join(' ');
  if (whole.length >= MIN_BANK_TEXT && text.includes(whole)) return 2;
  // e.g. a payroll whose memo QuickBooks kept from an earlier month
  const payee = plainText(t.payee);
  if (entryDate === t.date && payee.length >= MIN_BANK_TEXT && text.includes(payee)) return 1;
  return 0;
}

/**
 * Entries already in the books that move this amount through this account
 * near this date (BK-4): ones with the bank's text first, then the check
 * number, then the closest date.
 */
export function matchCandidates(
  db: Database,
  t: BankTxn,
  names = accountFullNames(db),
): MatchCandidate[] {
  return db
    .selectObjects(
      `SELECT e.id, e.date, e.ref, e.name, e.memo, e.source_type,
              (SELECT group_concat(coalesce(l.memo, e.memo), ' ') FROM journal_line l
               WHERE l.entry_id = e.id AND l.account_id = :account) AS bank_text
       FROM journal_entry e
       WHERE e.status = 'posted'
         AND e.date BETWEEN date(:date, '-${MATCH_DAYS} days') AND date(:date, '+${MATCH_DAYS} days')
         AND (SELECT sum(debit - credit) FROM journal_line WHERE entry_id = e.id AND account_id = :account) = :amount
         AND NOT EXISTS (SELECT 1 FROM bank_txn b WHERE b.entry_id = e.id AND b.account_id = :account)
       ORDER BY (e.ref IS NOT NULL AND e.ref = :check) DESC,
                abs(julianday(e.date) - julianday(:date)), e.id
       LIMIT 20`,
      { ':date': t.date, ':account': t.accountId, ':amount': t.amount, ':check': t.checkNo },
    )
    .map((r) => ({
      r,
      bankText: bankTextScore(t, r.bank_text === null ? null : String(r.bank_text), String(r.date)),
    }))
    .sort((a, b) => b.bankText - a.bankText)
    .slice(0, 5)
    .map(({ r, bankText }) => ({
      entryId: Number(r.id),
      date: String(r.date),
      ref: r.ref === null ? null : String(r.ref),
      name: r.name === null ? null : String(r.name),
      memo: r.memo === null ? null : String(r.memo),
      sourceType: String(r.source_type),
      accounts: otherAccounts(db, names, Number(r.id), t.accountId),
      bankText,
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

/**
 * A payee the way banks vary it between statements: "DP FRANCH DES:FEES ID:DP_67 I"
 * and "DP Franch des:fees" are the same payee. Capitals, anything from " ID:"
 * or " INDN:" on, and words with digits are ignored; the first four words count.
 */
export function payeeKey(payee: string | null): string {
  if (!payee) return '';
  return payee
    .toUpperCase()
    .replace(/\s(ID|INDN|CO ID|CONF)[:#].*$/, '')
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w))
    .slice(0, 4)
    .join(' ');
}

export type History = Map<string, Suggestion>;

/**
 * A payee and which way the money went: a payee's deposits (a refund, a
 * rebate) usually go to another category than its payments.
 */
const historyKey = (payee: string | null, amount: Cents) => {
  const key = payeeKey(payee);
  return key && `${amount > 0 ? 'in' : 'out'} ${key}`;
};

/**
 * How each payee was last put in the books in this account, when that was a
 * single category, for deposits and payments apart: from the review here, and
 * from transactions matched to entries already in the books, such as
 * QuickBooks history.
 */
export function historyIndex(db: Database, accountId: string): History {
  const index: History = new Map();
  const rows = db.selectObjects(
    `SELECT b.payee, b.amount, e.name, min(l.account_id) AS category, count(DISTINCT l.account_id) AS n
     FROM bank_txn b
     JOIN journal_entry e ON e.id = b.entry_id AND e.status = 'posted'
     JOIN journal_line l ON l.entry_id = e.id AND l.account_id <> b.account_id
     JOIN account a ON a.id = l.account_id AND a.active = 1
     WHERE b.account_id = ? AND b.status IN ('posted', 'matched') AND b.payee IS NOT NULL
     GROUP BY b.id ORDER BY b.date DESC, b.id DESC LIMIT 5000`,
    [accountId],
  );
  // The last few uses of each payee each way, newest first; a split has no single category
  const uses = new Map<string, { category: string | null; payee: string | null }[]>();
  for (const r of rows) {
    const key = historyKey(String(r.payee), Number(r.amount));
    if (!key) continue;
    const list = uses.get(key) ?? [];
    if (list.length >= HISTORY_USES) continue;
    list.push({
      category: Number(r.n) === 1 ? String(r.category) : null,
      payee: r.name === null ? null : String(r.name),
    });
    uses.set(key, list);
  }
  // Only a payee whose recent uses agree: a bank's "Check" or "Zelle payment
  // to" is a different payee each time, so its last category says nothing
  for (const [key, list] of uses) {
    const category = list[0]!.category;
    if (category && list.every((u) => u.category === category)) {
      index.set(key, { source: 'history', categoryId: category, payee: list[0]!.payee });
    }
  }
  return index;
}

/** How many of a payee's latest uses must agree for "like last time". */
const HISTORY_USES = 3;

/**
 * Payees with a default category (AP-1), by their name compared the way bank
 * payees vary (payeeKey): "HOME DEPOT #0149" finds the payee "Home Depot".
 * A name two payees share this way says nothing, so it's left out.
 */
export function vendorDefaults(db: Database): History {
  const index: History = new Map();
  const shared = new Set<string>();
  const rows = db.selectObjects(
    `SELECT p.name, p.default_account_id FROM payee p
     JOIN account a ON a.id = p.default_account_id AND a.active = 1
     WHERE p.active = 1`,
  );
  for (const r of rows) {
    const key = payeeKey(String(r.name));
    if (!key) continue;
    if (index.has(key)) shared.add(key);
    index.set(key, {
      source: 'vendor',
      categoryId: String(r.default_account_id),
      payee: String(r.name),
    });
  }
  for (const key of shared) index.delete(key);
  return index;
}

function suggest(
  t: BankTxn,
  rules: RuleRow[],
  history: History,
  vendors: History = new Map(),
): Suggestion | null {
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
  return (
    history.get(historyKey(t.payee, t.amount)) ??
    (t.amount < 0 ? vendors.get(payeeKey(t.payee)) : undefined) ??
    null
  );
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
  const history: History = view === 'new' ? historyIndex(db, accountId) : new Map();
  const vendors: History = view === 'new' ? vendorDefaults(db) : new Map();
  return rows.map((t) => {
    if (t.status !== 'new') {
      return {
        ...t,
        suggestion: null,
        matches: [],
        transfer: null,
        possibleDuplicate: false,
        alreadyInBooks: false,
        entryAccounts: t.entryId === null ? null : otherAccounts(db, names, t.entryId, t.accountId),
      };
    }
    const matches = matchCandidates(db, t, names);
    return {
      ...t,
      suggestion: suggest(t, rules, history, vendors),
      matches,
      transfer: matches.length ? null : transferCandidate(db, t, names),
      possibleDuplicate: t.duplicateOf !== null,
      alreadyInBooks: matches.some((m) => m.sourceType === 'qbo_migration'),
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
    const taken = db.selectValue(
      'SELECT count(*) FROM bank_txn WHERE entry_id = ? AND account_id = ?',
      [entryId, t.accountId],
    );
    if (Number(taken) > 0) {
      throw new LedgerRuleError(
        'That entry is already matched to another transaction in this account. Choose another match.',
      );
    }
    setReviewed(db, t, 'matched', entryId);
  });
}

/**
 * Match in one go the waiting transactions that have an entry with their bank
 * text (BK-4, BK-6), such as QuickBooks history from its bank feed. When
 * transactions alike (the same charge twice in a week) could take the same
 * entry, the whole bank text and then the closest dates pair up first.
 * Returns how many were matched.
 */
export function matchByBankText(db: Database, ids: number[]): number {
  return inSavepoint(db, 'bank_match_text', () => {
    const names = accountFullNames(db);
    const pairs = ids.flatMap((id) => {
      const t = getTxn(db, id);
      if (t.status !== 'new') return [];
      return matchCandidates(db, t, names)
        .filter((m) => m.bankText > 0)
        .map((m) => ({ t, m, days: Math.abs(Date.parse(m.date) - Date.parse(t.date)) }));
    });
    pairs.sort((a, b) => b.m.bankText - a.m.bankText || a.days - b.days || a.t.id - b.t.id);
    const done = new Set<number>();
    const taken = new Set<string>();
    for (const { t, m } of pairs) {
      const entry = `${t.accountId} ${m.entryId}`;
      if (done.has(t.id) || taken.has(entry)) continue;
      match(db, t.id, m.entryId);
      done.add(t.id);
      taken.add(entry);
    }
    return done.size;
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
 * Ones that may already be in the books (a matching entry) or fall in a
 * closed period are left for the owner, so a bulk accept never enters
 * anything twice. Returns the new entries.
 */
export function acceptSuggestions(db: Database, ids: number[], opts: PostOptions = {}): number[] {
  return inSavepoint(db, 'bank_accept', () => {
    const rules = listRules(db).filter((r) => r.active);
    const closing = db.selectValue('SELECT closing_date FROM company');
    const vendors = vendorDefaults(db);
    const posted: number[] = [];
    for (const id of ids) {
      const t = getTxn(db, id);
      if (t.status !== 'new' || matchCandidates(db, t).length > 0) continue;
      // Never in bulk into a closed period, e.g. history brought over from
      // QuickBooks: those are looked at one by one
      if (typeof closing === 'string' && t.date <= closing) continue;
      const s = suggest(t, rules, historyIndex(db, t.accountId), vendors);
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
