// Account balances as of a date, with the year-end close built in (PC-3).
//
// Nothing is "run" at year end. Income and expense accounts show only the
// current fiscal year; everything earned or spent in earlier years appears in
// Retained Earnings, as QuickBooks does. The ledger itself is never changed.

import type { AccountType } from '../shared/accounts';
import type { Cents } from '../shared/money';
import type { Database } from '../worker/sqlite';
import { accountFullNames } from './accounts';

/** First day of the fiscal year containing `asOf` (YYYY-MM-DD). */
export function fiscalYearStart(asOf: string, startMonth: number): string {
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
}

export interface TrialBalanceRow {
  /** null for retained earnings when the company has no such account yet */
  accountId: string | null;
  account: string;
  type: AccountType;
  debit: Cents;
  credit: Cents;
}

export interface TrialBalance {
  asOf: string;
  fiscalYearStart: string;
  rows: TrialBalanceRow[];
  totalDebit: Cents;
  totalCredit: Cents;
}

const TYPE_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

/** Trial balance of posted entries on or before `asOf` (RP-4 builds on this in M4). */
export function trialBalance(db: Database, asOf: string): TrialBalance {
  const startMonth = Number(db.selectValue('SELECT fiscal_year_start_month FROM company'));
  const fyStart = fiscalYearStart(asOf, startMonth);
  const net = new Map<string, { type: AccountType; detailType: string; net: bigint }>();
  for (const r of db.selectArrays(
    `SELECT a.id, a.type, a.detail_type, sum(l.debit - l.credit)
     FROM journal_line l
     JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted' AND e.date <= ?
     JOIN account a ON a.id = l.account_id
     WHERE a.type NOT IN ('income', 'expense') OR e.date >= ?
     GROUP BY a.id`,
    [asOf, fyStart],
  )) {
    net.set(String(r[0]), {
      type: r[1] as AccountType,
      detailType: String(r[2]),
      net: BigInt(Number(r[3])),
    });
  }
  // Earlier years' net income, as a debit-minus-credit amount
  const prior = BigInt(
    Number(
      db.selectValue(
        `SELECT coalesce(sum(l.debit - l.credit), 0)
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted' AND e.date < ?
         JOIN account a ON a.id = l.account_id
         WHERE a.type IN ('income', 'expense')`,
        [fyStart],
      ),
    ),
  );
  const names = accountFullNames(db);
  const reId = db.selectValue(`SELECT id FROM account WHERE detail_type = 'retained_earnings'`);
  const reKey = reId === undefined ? '' : String(reId);
  if (prior !== 0n) {
    const re = net.get(reKey) ?? {
      type: 'equity' as const,
      detailType: 'retained_earnings',
      net: 0n,
    };
    net.set(reKey, { ...re, net: re.net + prior });
  }
  const rows: TrialBalanceRow[] = [...net.entries()]
    .filter(([, v]) => v.net !== 0n)
    .map(([id, v]) => ({
      accountId: id || null,
      account: id ? (names.get(id) ?? '?') : 'Retained Earnings',
      type: v.type,
      debit: v.net > 0n ? Number(v.net) : 0,
      credit: v.net < 0n ? Number(-v.net) : 0,
    }))
    .sort(
      (a, b) =>
        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
        a.account.localeCompare(b.account, undefined, { sensitivity: 'base' }),
    );
  const total = (k: 'debit' | 'credit') => rows.reduce((s, r) => s + BigInt(r[k]), 0n);
  return {
    asOf,
    fiscalYearStart: fyStart,
    rows,
    totalDebit: Number(total('debit')),
    totalCredit: Number(total('credit')),
  };
}
