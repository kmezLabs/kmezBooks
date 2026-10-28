// Statement import (BK-1, BK-6): read .qbo files, show what's in them and
// which account each belongs to, then add their transactions to the review
// queue, leaving out the ones already imported.

import type { Cents } from '../../shared/money';
import { inSavepoint } from '../../ledger/tx';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';
import {
  decodeOfx,
  feedKey,
  feedLabel,
  OfxError,
  parseOfx,
  type OfxStatement,
  type OfxTransaction,
} from './ofx';
import { autoProcess, type AutoResult } from './review';

export interface StatementFile {
  name: string;
  bytes: Uint8Array;
}

/** A statement read from a file, waiting for the owner to confirm its account. */
export interface PendingStatement {
  file: string;
  key: string;
  label: string;
  statement: OfxStatement;
}

export interface StatementPreview {
  file: string;
  key: string;
  label: string;
  kind: OfxStatement['kind'];
  startDate: string | null;
  endDate: string | null;
  balance: Cents | null;
  balanceDate: string | null;
  transactions: number;
  /** The account this statement went into last time, or else a likely one */
  accountId: string | null;
  /** accountId is a guess from the account's name, not remembered from last time */
  guessed: boolean;
}

export interface FileProblem {
  file: string;
  message: string;
}

export interface ImportedStatement {
  label: string;
  accountId: string;
  added: number;
  duplicates: number;
  /** Same bank id as an earlier transaction but a different date or amount, kept for review */
  flagged: number;
}

export interface StatementImportResult extends AutoResult {
  statements: ImportedStatement[];
}

/** Read statement files; files that aren't statements are reported, not thrown. */
export function readStatements(files: StatementFile[]): {
  pending: PendingStatement[];
  problems: FileProblem[];
} {
  const pending: PendingStatement[] = [];
  const problems: FileProblem[] = [];
  for (const f of files) {
    try {
      for (const statement of parseOfx(decodeOfx(f.bytes))) {
        if (statement.currency && statement.currency.toUpperCase() !== 'USD') {
          problems.push({
            file: f.name,
            message: `${feedLabel(statement)} is in ${statement.currency}; EasyBooks keeps books in US dollars only.`,
          });
          continue;
        }
        pending.push({
          file: f.name,
          key: feedKey(statement),
          label: feedLabel(statement),
          statement,
        });
      }
    } catch (e) {
      if (!(e instanceof OfxError)) throw e;
      problems.push({ file: f.name, message: e.message });
    }
  }
  return { pending, problems };
}

export function previewStatements(db: Database, pending: PendingStatement[]): StatementPreview[] {
  return pending.map((p) => ({
    file: p.file,
    key: p.key,
    label: p.label,
    kind: p.statement.kind,
    startDate: p.statement.startDate,
    endDate: p.statement.endDate,
    balance: p.statement.balance,
    balanceDate: p.statement.balanceDate,
    transactions: p.statement.transactions.length,
    ...chosenAccount(db, p),
  }));
}

function chosenAccount(
  db: Database,
  p: PendingStatement,
): { accountId: string | null; guessed: boolean } {
  const remembered = feedAccount(db, p.key);
  if (remembered) return { accountId: remembered, guessed: false };
  const guess = guessAccount(db, p);
  return { accountId: guess, guessed: guess !== null };
}

/**
 * The ledger account a new statement probably belongs to: the one account of
 * its kind (bank or card) whose name has the statement account's last four
 * digits, as in "BoA Mastercard (AFM-0860)"; or the only account of that
 * kind. Null when it isn't clear; the owner chooses.
 */
function guessAccount(db: Database, p: PendingStatement): string | null {
  const type = p.statement.kind === 'card' ? 'liability' : 'asset';
  const accounts = db
    .selectObjects(`SELECT id, name, detail_type FROM account WHERE active = 1 AND type = ?`, [
      type,
    ])
    .map((r) => ({ id: String(r.id), name: String(r.name), detail: String(r.detail_type) }));
  const last4 = p.statement.accountNumber.slice(-4);
  const byDigits = accounts.filter((a) => new RegExp(`(^|\\D)${last4}(\\D|$)`).test(a.name));
  if (byDigits.length === 1) return byDigits[0]!.id;
  const ofKind = accounts.filter(
    (a) => a.detail === (p.statement.kind === 'card' ? 'credit_card' : 'bank'),
  );
  return ofKind.length === 1 ? ofKind[0]!.id : null;
}

function feedAccount(db: Database, key: string): string | null {
  const id = db.selectValue('SELECT account_id FROM bank_feed WHERE feed_key = ?', [key]);
  return id === undefined || id === null ? null : String(id);
}

/** Already imported (BK-6): the same bank id, date and amount; or, without a bank id, the same details. */
function existing(db: Database, accountId: string, t: OfxTransaction): number | null {
  const id =
    t.fitid !== null
      ? db.selectValue(
          `SELECT id FROM bank_txn WHERE account_id = ? AND fitid = ? AND date = ? AND amount = ?`,
          [accountId, t.fitid, t.date, t.amount],
        )
      : db.selectValue(
          `SELECT id FROM bank_txn WHERE account_id = ? AND fitid IS NULL AND date = ? AND amount = ?
             AND payee IS ? AND memo IS ? AND check_no IS ?`,
          [accountId, t.date, t.amount, t.name, t.memo, t.checkNo],
        );
  return id === undefined ? null : Number(id);
}

/**
 * An earlier transaction from another file with the same bank id but a
 * different date or amount. Within one file a shared id means two different
 * transactions (Bank of America reuses ids within a day).
 */
function sameFitid(
  db: Database,
  accountId: string,
  importId: string,
  t: OfxTransaction,
): number | null {
  if (t.fitid === null) return null;
  const id = db.selectValue(
    `SELECT min(id) FROM bank_txn WHERE account_id = ? AND fitid = ? AND import_id <> ?`,
    [accountId, t.fitid, importId],
  );
  return id === undefined || id === null ? null : Number(id);
}

/**
 * Import the statements into the accounts chosen for them (key → account).
 * Statements without a chosen account are skipped. Everything is one
 * savepoint: all of it is imported, or none.
 */
export function importStatements(
  db: Database,
  pending: PendingStatement[],
  accounts: Record<string, string>,
): StatementImportResult {
  return inSavepoint(db, 'bank_import', () => {
    const results: ImportedStatement[] = [];
    const added: number[] = [];
    for (const p of pending) {
      const accountId = accounts[p.key];
      if (!accountId) continue;
      const active = db.selectValue('SELECT active FROM account WHERE id = ?', [accountId]);
      if (active === undefined) throw new LedgerRuleError('Choose an account for each statement.');
      if (active === 0) throw new LedgerRuleError('That account is inactive.');
      rememberFeed(db, p, accountId);

      const importId = crypto.randomUUID();
      db.exec({
        sql: `INSERT INTO bank_import (id, company_id, account_id, file_name, start_date, end_date,
                                       balance, balance_date, added, duplicates)
              VALUES (?, (SELECT id FROM company), ?, ?, ?, ?, ?, ?, 0, 0)`,
        bind: [
          importId,
          accountId,
          p.file,
          p.statement.startDate,
          p.statement.endDate,
          p.statement.balance,
          p.statement.balanceDate,
        ],
      });
      let duplicates = 0;
      let flagged = 0;
      let count = 0;
      for (const t of p.statement.transactions) {
        if (existing(db, accountId, t) !== null) {
          duplicates++;
          continue;
        }
        const duplicateOf = sameFitid(db, accountId, importId, t);
        if (duplicateOf !== null) flagged++;
        const id = db.selectValue(
          `INSERT INTO bank_txn (company_id, account_id, import_id, fitid, date, amount, payee, memo,
                                 check_no, trn_type, duplicate_of)
           VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            accountId,
            importId,
            t.fitid,
            t.date,
            t.amount,
            t.name,
            t.memo,
            t.checkNo,
            t.type,
            duplicateOf,
          ],
        );
        added.push(Number(id));
        count++;
      }
      db.exec({
        sql: 'UPDATE bank_import SET added = ?, duplicates = ? WHERE id = ?',
        bind: [count, duplicates, importId],
      });
      results.push({ label: p.label, accountId, added: count, duplicates, flagged });
    }
    return { statements: results, ...autoProcess(db, added) };
  });
}

/** Remember which account a statement belongs to, replacing an earlier choice. */
function rememberFeed(db: Database, p: PendingStatement, accountId: string) {
  const current = db.selectObjects(
    'SELECT account_id, feed_key FROM bank_feed WHERE feed_key = ? OR account_id = ?',
    [p.key, accountId],
  );
  if (
    current.length === 1 &&
    current[0]!.account_id === accountId &&
    current[0]!.feed_key === p.key
  )
    return;
  db.exec({
    sql: 'DELETE FROM bank_feed WHERE feed_key = ? OR account_id = ?',
    bind: [p.key, accountId],
  });
  db.exec({
    sql: `INSERT INTO bank_feed (account_id, company_id, feed_key, label) VALUES (?, (SELECT id FROM company), ?, ?)`,
    bind: [accountId, p.key, p.label],
  });
}

export interface ImportRow {
  id: string;
  accountId: string;
  fileName: string;
  importedAt: string;
  startDate: string | null;
  endDate: string | null;
  balance: Cents | null;
  balanceDate: string | null;
  added: number;
  duplicates: number;
  /** Still in the review queue or excluded, so removed by undoing the import */
  removable: number;
}

export function listImports(db: Database, accountId: string, limit = 20): ImportRow[] {
  return db
    .selectObjects(
      `SELECT i.*, (SELECT count(*) FROM bank_txn b WHERE b.import_id = i.id AND b.status IN ('new', 'excluded')) AS removable
       FROM bank_import i WHERE i.account_id = ? ORDER BY i.imported_at DESC LIMIT ?`,
      [accountId, limit],
    )
    .map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      fileName: String(r.file_name),
      importedAt: String(r.imported_at),
      startDate: r.start_date === null ? null : String(r.start_date),
      endDate: r.end_date === null ? null : String(r.end_date),
      balance: r.balance === null ? null : Number(r.balance),
      balanceDate: r.balance_date === null ? null : String(r.balance_date),
      added: Number(r.added),
      duplicates: Number(r.duplicates),
      removable: Number(r.removable),
    }));
}

/**
 * Undo an import: its transactions still waiting for review (or excluded) are
 * removed. Ones already in the books stay; undo those in the review first.
 * Returns how many were removed.
 */
export function undoImport(db: Database, importId: string): number {
  return inSavepoint(db, 'bank_undo_import', () => {
    db.exec({
      sql: `UPDATE bank_txn SET duplicate_of = NULL WHERE duplicate_of IN (
              SELECT id FROM bank_txn WHERE import_id = ? AND status IN ('new', 'excluded'))`,
      bind: [importId],
    });
    db.exec({
      sql: `DELETE FROM bank_txn WHERE import_id = ? AND status IN ('new', 'excluded')`,
      bind: [importId],
    });
    const removed = db.changes();
    const left = Number(
      db.selectValue('SELECT count(*) FROM bank_txn WHERE import_id = ?', [importId]),
    );
    if (left === 0) db.exec({ sql: 'DELETE FROM bank_import WHERE id = ?', bind: [importId] });
    return removed;
  });
}
