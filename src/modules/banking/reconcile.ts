// Reconciliation (BK-7, BK-8): check an account's entries off against a bank
// or card statement until the difference is zero, then keep the result. The
// schema refuses to finish with a difference, to change a finished one, or to
// clear an item twice. Balances here are debit minus credit, as the ledger
// counts the account; the screen shows them the way the statement does.

import type { AccountType } from '../../shared/accounts';
import type { Cents } from '../../shared/money';
import { accountFullNames } from '../../ledger/accounts';
import { isIsoDate } from '../../ledger/postEntry';
import { inSavepoint } from '../../ledger/tx';
import { LedgerRuleError } from '../../worker/errors';
import type { Database } from '../../worker/sqlite';

/** At most this many items are listed; the rest are counted and can be cleared together. */
export const ITEMS_SHOWN = 3000;

export interface StatementRef {
  id: string;
  statementDate: string;
  endingBalance: Cents;
}

export interface ReconcileItem {
  lineId: number;
  entryId: number;
  date: string;
  ref: string | null;
  name: string | null;
  memo: string | null;
  /** Debit minus credit */
  amount: Cents;
  cleared: boolean;
}

export interface ReconcileState {
  accountId: string;
  accountType: AccountType;
  /** The last finished reconciliation */
  last: StatementRef | null;
  open: StatementRef | null;
  /** The last statement's ending balance, where this one starts */
  beginningBalance: Cents;
  /** Uncleared items dated on or before the statement date, oldest first (newest ITEMS_SHOWN) */
  items: ReconcileItem[];
  itemCount: number;
  clearedCount: number;
  clearedTotal: Cents;
  /** Statement ending balance minus (beginning balance + cleared items): zero to finish */
  difference: Cents;
  /** The latest imported statement's balance after the last reconciliation, to start from */
  suggested: { statementDate: string; endingBalance: Cents } | null;
}

const statementRef = (r: Record<string, unknown> | undefined): StatementRef | null =>
  r
    ? {
        id: String(r.id),
        statementDate: String(r.statement_date),
        endingBalance: Number(r.ending_balance),
      }
    : null;

function lastDone(db: Database, accountId: string): StatementRef | null {
  return statementRef(
    db.selectObjects(
      `SELECT id, statement_date, ending_balance FROM reconciliation
       WHERE account_id = ? AND status = 'done' ORDER BY statement_date DESC LIMIT 1`,
      [accountId],
    )[0],
  );
}

function openOne(db: Database, accountId: string): StatementRef | null {
  return statementRef(
    db.selectObjects(
      `SELECT id, statement_date, ending_balance FROM reconciliation WHERE account_id = ? AND status = 'open'`,
      [accountId],
    )[0],
  );
}

/** Posted lines in the account, not cleared by a finished reconciliation, on or before the date. */
const CANDIDATES = `
  FROM journal_line l
  JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
  LEFT JOIN reconciled_line r ON r.line_id = l.id
  WHERE l.account_id = :account AND e.date <= :date
    AND (r.line_id IS NULL OR r.reconciliation_id = :open)`;

export function reconcileState(
  db: Database,
  accountId: string,
  limit = ITEMS_SHOWN,
): ReconcileState {
  const type = db.selectValue('SELECT type FROM account WHERE id = ?', [accountId]);
  if (type === undefined) throw new LedgerRuleError('That account does not exist.');
  const last = lastDone(db, accountId);
  const open = openOne(db, accountId);
  const beginningBalance = last?.endingBalance ?? 0;
  const base: ReconcileState = {
    accountId,
    accountType: type as AccountType,
    last,
    open,
    beginningBalance,
    items: [],
    itemCount: 0,
    clearedCount: 0,
    clearedTotal: 0,
    difference: 0,
    suggested: null,
  };
  if (!open) {
    // Some banks (Bank of America) date the statement's ending balance when it
    // was downloaded; it is the balance on the statement's last day
    const s = db.selectObjects(
      `SELECT statement_date, balance FROM (
         SELECT CASE WHEN end_date IS NOT NULL AND balance_date > end_date THEN end_date
                     ELSE balance_date END AS statement_date,
                balance, imported_at
         FROM bank_import WHERE account_id = ? AND balance IS NOT NULL AND balance_date IS NOT NULL)
       WHERE statement_date > ?
       ORDER BY statement_date DESC, imported_at DESC LIMIT 1`,
      [accountId, last?.statementDate ?? '0000-00-00'],
    )[0];
    return {
      ...base,
      suggested: s
        ? { statementDate: String(s.statement_date), endingBalance: Number(s.balance) }
        : null,
    };
  }
  const bind = { ':account': accountId, ':date': open.statementDate, ':open': open.id };
  const totals = db.selectObjects(
    `SELECT count(*) AS n, count(r.line_id) AS cleared,
            coalesce(sum(CASE WHEN r.line_id IS NOT NULL THEN l.debit - l.credit END), 0) AS total
     ${CANDIDATES}`,
    bind,
  )[0]!;
  const items = db
    .selectObjects(
      `SELECT l.id AS line_id, e.id AS entry_id, e.date, e.ref, coalesce(l.name, e.name) AS name,
              coalesce(l.memo, e.memo) AS memo, l.debit - l.credit AS amount, r.line_id IS NOT NULL AS cleared
       ${CANDIDATES}
       ORDER BY e.date DESC, e.id DESC, l.line_no DESC LIMIT :limit`,
      { ...bind, ':limit': limit },
    )
    .map((r) => ({
      lineId: Number(r.line_id),
      entryId: Number(r.entry_id),
      date: String(r.date),
      ref: r.ref === null ? null : String(r.ref),
      name: r.name === null ? null : String(r.name),
      memo: r.memo === null ? null : String(r.memo),
      amount: Number(r.amount),
      cleared: r.cleared === 1,
    }))
    .reverse();
  const clearedTotal = Number(totals.total);
  return {
    ...base,
    items,
    itemCount: Number(totals.n),
    clearedCount: Number(totals.cleared),
    clearedTotal,
    difference: open.endingBalance - (beginningBalance + clearedTotal),
  };
}

function checkStatement(statementDate: string, endingBalance: Cents) {
  if (!isIsoDate(statementDate)) throw new LedgerRuleError('Enter the statement date.');
  if (!Number.isSafeInteger(endingBalance)) throw new LedgerRuleError('Enter the ending balance.');
}

/** Start reconciling a statement. Returns the reconciliation's id. */
export function startReconciliation(
  db: Database,
  accountId: string,
  statementDate: string,
  endingBalance: Cents,
): string {
  checkStatement(statementDate, endingBalance);
  const id = crypto.randomUUID();
  inSavepoint(db, 'reconcile_start', () => {
    if (openOne(db, accountId))
      throw new LedgerRuleError('This account already has a reconciliation in progress.');
    db.exec({
      sql: `INSERT INTO reconciliation (id, company_id, account_id, statement_date, ending_balance)
            VALUES (?, (SELECT id FROM company), ?, ?, ?)`,
      bind: [id, accountId, statementDate, endingBalance],
    });
  });
  return id;
}

/** Change the statement date or ending balance of a reconciliation in progress. */
export function updateReconciliation(
  db: Database,
  id: string,
  statementDate: string,
  endingBalance: Cents,
): void {
  checkStatement(statementDate, endingBalance);
  inSavepoint(db, 'reconcile_update', () =>
    db.exec({
      sql: `UPDATE reconciliation SET statement_date = ?, ending_balance = ? WHERE id = ?`,
      bind: [statementDate, endingBalance, id],
    }),
  );
}

/** Check items off (or uncheck them). */
export function setCleared(db: Database, id: string, lineIds: number[], cleared: boolean): void {
  inSavepoint(db, 'reconcile_clear', () => {
    const stmt = db.prepare(
      cleared
        ? `INSERT INTO reconciled_line (line_id, company_id, reconciliation_id)
           VALUES (?, (SELECT id FROM company), ?) ON CONFLICT (line_id) DO NOTHING`
        : `DELETE FROM reconciled_line WHERE line_id = ? AND reconciliation_id = ?`,
    );
    try {
      for (const lineId of lineIds) stmt.bind([lineId, id]).stepReset();
    } finally {
      stmt.finalize();
    }
  });
}

/** Check off (or uncheck) every item on or before the statement date. */
export function setAllCleared(db: Database, id: string, cleared: boolean): void {
  inSavepoint(db, 'reconcile_clear_all', () => {
    const r = db.selectObjects(
      `SELECT account_id, statement_date, status FROM reconciliation WHERE id = ?`,
      [id],
    )[0];
    if (!r) throw new LedgerRuleError('That reconciliation no longer exists.');
    if (!cleared) {
      db.exec({ sql: 'DELETE FROM reconciled_line WHERE reconciliation_id = ?', bind: [id] });
      return;
    }
    db.exec({
      sql: `INSERT INTO reconciled_line (line_id, company_id, reconciliation_id)
            SELECT l.id, (SELECT id FROM company), :open ${CANDIDATES} AND r.line_id IS NULL`,
      bind: { ':account': String(r.account_id), ':date': String(r.statement_date), ':open': id },
    });
  });
}

/** Finish: the schema checks the difference is zero (BK-7). */
export function finishReconciliation(db: Database, id: string): void {
  inSavepoint(db, 'reconcile_finish', () => {
    const r = db.selectObjects(`SELECT account_id FROM reconciliation WHERE id = ?`, [id])[0];
    if (!r) throw new LedgerRuleError('That reconciliation no longer exists.');
    const last = lastDone(db, String(r.account_id));
    db.exec({
      sql: `UPDATE reconciliation SET status = 'done', beginning_balance = ?,
                   finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?`,
      bind: [last?.endingBalance ?? 0, id],
    });
  });
}

/** Stop a reconciliation in progress, unchecking everything. */
export function cancelReconciliation(db: Database, id: string): void {
  inSavepoint(db, 'reconcile_cancel', () => {
    db.exec({ sql: 'DELETE FROM reconciled_line WHERE reconciliation_id = ?', bind: [id] });
    db.exec({ sql: `DELETE FROM reconciliation WHERE id = ?`, bind: [id] });
  });
}

// ---- reports (BK-8) ----

export interface ReconciliationSummary extends StatementRef {
  accountId: string;
  beginningBalance: Cents;
  finishedAt: string;
  clearedCount: number;
  /** Cleared items whose entry has been voided since (BK-8) */
  changedCount: number;
}

export function reconciliationHistory(db: Database, accountId: string): ReconciliationSummary[] {
  return db
    .selectObjects(
      `SELECT c.*, (SELECT count(*) FROM reconciled_line r WHERE r.reconciliation_id = c.id) AS cleared,
              (SELECT count(*) FROM reconciled_line r JOIN journal_line l ON l.id = r.line_id
                 JOIN journal_entry e ON e.id = l.entry_id
               WHERE r.reconciliation_id = c.id AND e.status = 'void') AS changed
       FROM reconciliation c WHERE c.account_id = ? AND c.status = 'done' ORDER BY c.statement_date DESC`,
      [accountId],
    )
    .map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      statementDate: String(r.statement_date),
      endingBalance: Number(r.ending_balance),
      beginningBalance: Number(r.beginning_balance),
      finishedAt: String(r.finished_at),
      clearedCount: Number(r.cleared),
      changedCount: Number(r.changed),
    }));
}

export interface ReportItem extends Omit<ReconcileItem, 'cleared'> {
  /** Voided after it was reconciled (BK-8) */
  voided: boolean;
}

export interface ReconciliationReport {
  summary: ReconciliationSummary;
  account: string;
  accountType: AccountType;
  cleared: ReportItem[];
  /** Items on or before the statement date that are still not cleared */
  outstanding: ReportItem[];
}

export function reconciliationReport(db: Database, id: string): ReconciliationReport {
  const head = db.selectObjects(
    `SELECT account_id FROM reconciliation WHERE id = ? AND status = 'done'`,
    [id],
  )[0];
  if (!head) throw new LedgerRuleError('That reconciliation does not exist.');
  const accountId = String(head.account_id);
  const summary = reconciliationHistory(db, accountId).find((s) => s.id === id)!;
  const item = (r: Record<string, unknown>): ReportItem => ({
    lineId: Number(r.line_id),
    entryId: Number(r.entry_id),
    date: String(r.date),
    ref: r.ref === null ? null : String(r.ref),
    name: r.name === null ? null : String(r.name),
    memo: r.memo === null ? null : String(r.memo),
    amount: Number(r.amount),
    voided: r.status === 'void',
  });
  const columns = `l.id AS line_id, e.id AS entry_id, e.date, e.ref, coalesce(l.name, e.name) AS name,
                   coalesce(l.memo, e.memo) AS memo, l.debit - l.credit AS amount, e.status`;
  const cleared = db
    .selectObjects(
      `SELECT ${columns} FROM reconciled_line r JOIN journal_line l ON l.id = r.line_id
       JOIN journal_entry e ON e.id = l.entry_id
       WHERE r.reconciliation_id = ? ORDER BY e.date, e.id, l.line_no`,
      [id],
    )
    .map(item);
  const outstanding = db
    .selectObjects(
      `SELECT ${columns} FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted'
       WHERE l.account_id = ? AND e.date <= ?
         AND NOT EXISTS (SELECT 1 FROM reconciled_line r JOIN reconciliation c ON c.id = r.reconciliation_id
                         WHERE r.line_id = l.id AND c.status = 'done')
       ORDER BY e.date, e.id, l.line_no LIMIT ?`,
      [accountId, summary.statementDate, ITEMS_SHOWN],
    )
    .map(item);
  return {
    summary,
    account: accountFullNames(db).get(accountId) ?? '?',
    accountType: db.selectValue('SELECT type FROM account WHERE id = ?', [
      accountId,
    ]) as AccountType,
    cleared,
    outstanding,
  };
}

/** Finished reconciliations an entry's lines were cleared in, to warn before voiding it (BK-8). */
export function entryReconciliations(
  db: Database,
  entryId: number,
): { account: string; statementDate: string }[] {
  const names = accountFullNames(db);
  return db
    .selectObjects(
      `SELECT DISTINCT c.account_id, c.statement_date FROM reconciled_line r
       JOIN journal_line l ON l.id = r.line_id JOIN reconciliation c ON c.id = r.reconciliation_id
       WHERE l.entry_id = ? AND c.status = 'done' ORDER BY c.statement_date`,
      [entryId],
    )
    .map((r) => ({
      account: names.get(String(r.account_id)) ?? '?',
      statementDate: String(r.statement_date),
    }));
}
