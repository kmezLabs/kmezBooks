// The accounts banking works with (BK-1, BK-7): bank, cash and credit card
// accounts, lines of credit, and any account a statement has been imported into.

import type { AccountType } from '../../shared/accounts';
import { accountFullNames } from '../../ledger/accounts';
import type { Database } from '../../worker/sqlite';

export const BANKING_DETAIL_TYPES = ['bank', 'cash_on_hand', 'credit_card', 'line_of_credit'];

export interface BankAccount {
  id: string;
  name: string;
  type: AccountType;
  /** How the statement file names the account, once one has been imported */
  feedLabel: string | null;
  /** Transactions waiting for review */
  waiting: number;
  /** The last statement imported */
  lastImportAt: string | null;
  /** The last reconciled statement date */
  reconciledThrough: string | null;
}

export function bankAccounts(db: Database): BankAccount[] {
  const names = accountFullNames(db);
  return db
    .selectObjects(
      `SELECT a.id, a.type, f.label,
              (SELECT count(*) FROM bank_txn b WHERE b.account_id = a.id AND b.status = 'new') AS waiting,
              (SELECT max(imported_at) FROM bank_import i WHERE i.account_id = a.id) AS last_import,
              (SELECT max(statement_date) FROM reconciliation c WHERE c.account_id = a.id AND c.status = 'done') AS reconciled
       FROM account a LEFT JOIN bank_feed f ON f.account_id = a.id
       WHERE (a.active = 1 AND a.detail_type IN (${BANKING_DETAIL_TYPES.map(() => '?').join(', ')}))
          OR f.account_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM bank_txn b WHERE b.account_id = a.id)`,
      BANKING_DETAIL_TYPES,
    )
    .map((r) => ({
      id: String(r.id),
      name: names.get(String(r.id)) ?? '?',
      type: r.type as AccountType,
      feedLabel: r.label === null ? null : String(r.label),
      waiting: Number(r.waiting),
      lastImportAt: r.last_import === null ? null : String(r.last_import),
      reconciledThrough: r.reconciled === null ? null : String(r.reconciled),
    }))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'asset' ? -1 : 1,
    );
}
