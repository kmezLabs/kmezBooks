// A company with the default chart of accounts, for ledger tests.

import { seedDefaultChart } from '../../src/ledger/accounts';
import { postEntry, type EntryInput } from '../../src/ledger/postEntry';
import type { Database } from '../../src/worker/sqlite';
import { newCompanyDb } from './testDb';

export async function newLedgerDb(): Promise<Database> {
  const db = await newCompanyDb();
  seedDefaultChart(db);
  return db;
}

export function accountId(db: Database, name: string): string {
  const id = db.selectValue('SELECT id FROM account WHERE name = ?', [name]);
  if (id === undefined) throw new Error(`No account ${name}`);
  return String(id);
}

/** A simple two-line entry: debit one account, credit another. */
export function simple(
  db: Database,
  date: string,
  debitAccount: string,
  creditAccount: string,
  cents: number,
  extra: Partial<EntryInput> = {},
): EntryInput {
  return {
    date,
    sourceType: 'journal',
    lines: [
      { accountId: accountId(db, debitAccount), debit: cents, credit: 0 },
      { accountId: accountId(db, creditAccount), debit: 0, credit: cents },
    ],
    ...extra,
  };
}

export function post(
  db: Database,
  date: string,
  debitAccount: string,
  creditAccount: string,
  cents: number,
  extra: Partial<EntryInput> = {},
): number {
  return postEntry(db, simple(db, date, debitAccount, creditAccount, cents, extra));
}
