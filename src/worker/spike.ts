// M1 technical test only: made-up history at 17-year size and report timings.
// Runs only in a test company (CO-7). The history is posted into the real
// ledger through postEntry(), so it shows in Transactions, the registers and
// the reports, and the timings measure the real schema. Each run replaces the
// previous run's history; the schema lets only a test company delete it.
// Remove this file (and its UI) once docs/spikes/M1-results.md is written.

import { seedDefaultChart } from '../ledger/accounts';
import { postEntry, type EntryLineInput } from '../ledger/postEntry';
import { runReport } from '../ledger/reports';
import type { ReportRequest } from '../shared/report';
import { recordEvent } from './audit';
import { isTestCompany } from './companyData';
import type { Database, Sqlite3Static } from './sqlite';

export interface GenerateOptions {
  years: number;
  entriesPerYear: number;
  seed?: number;
  /** Today, so no entry is dated in the future; tests pass a fixed day. */
  today?: string;
}

export interface QueryTimings {
  plOneYearMs: number;
  plAllYearsMs: number;
  balanceSheetMs: number;
  trialBalanceMs: number;
}

/** source_type of the made-up entries */
export const TEST_HISTORY_SOURCE = 'test_history';

// Small seeded PRNG so every run generates the same data
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAYEES =
  'Acme Supply,Blue Sky Software,City Utilities,Corner Cafe,Delta Insurance,Eastside Fuel,First Street Landlord,Green Office Co,Harbor Parking,Lakeview Consulting,Metro Telecom,North Print Shop,Oak Hardware,Pine Travel,Riverside Repairs,Summit Legal,Valley Bank,West End Catering,Northwind Traders,Contoso Clients'.split(
    ',',
  );

const WORDS =
  'office supplies rent utilities consulting fees software travel meals insurance repairs fuel parking deposit payment refund'.split(
    ' ',
  );

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Old M1 runs wrote to these scratch tables; they're dropped on the next run. */
function dropOldScratchTables(db: Database) {
  db.exec(`DROP TABLE IF EXISTS spike_line;
           DROP TABLE IF EXISTS spike_entry;
           DROP TABLE IF EXISTS spike_account;`);
}

/**
 * Delete the previous run's made-up history, and undo what was done with it:
 * bank transactions matched to it go back to review, and it leaves any
 * reconciliation in progress. Returns how many entries went.
 */
function removeTestHistory(db: Database): number {
  const closed = Number(
    db.selectValue(
      `SELECT count(*) FROM journal_entry WHERE source_type = ? AND date <= (SELECT closing_date FROM company)`,
      [TEST_HISTORY_SOURCE],
    ),
  );
  if (closed > 0) {
    throw new Error(
      'Some made-up history is in the closed period, so it can’t be replaced. Move the closing date back on Close books first.',
    );
  }
  const entries = `SELECT id FROM journal_entry WHERE source_type = '${TEST_HISTORY_SOURCE}'`;
  const removed = Number(db.selectValue(`SELECT count(*) FROM (${entries})`));
  db.exec(`UPDATE bank_txn SET status = 'new', entry_id = NULL WHERE entry_id IN (${entries});
           DELETE FROM reconciled_line WHERE line_id IN
             (SELECT id FROM journal_line WHERE entry_id IN (${entries}));
           DELETE FROM journal_line WHERE entry_id IN (${entries});
           DELETE FROM journal_entry WHERE source_type = '${TEST_HISTORY_SOURCE}';`);
  return removed;
}

function ids(db: Database, where: string): string[] {
  return db
    .selectArrays(`SELECT id FROM account WHERE active = 1 AND ${where} ORDER BY name`)
    .map((r) => String(r[0]));
}

/**
 * Replace the made-up history with new: `entriesPerYear` deposits and
 * payments for each of the last `years` calendar years, up to today. Money
 * moves in and out of the company's bank and card accounts, against its
 * income and expense accounts, so every entry is an ordinary cash-basis
 * posting. Entries the owner made themselves stay. A company with no
 * accounts gets the standard chart first. All or nothing: one transaction.
 */
export function generateHistory(
  db: Database,
  opts: GenerateOptions,
): { removed: number; entries: number; lines: number } {
  if (!isTestCompany(db)) throw new Error('The technical test runs only in a test company.');
  const rand = mulberry32(opts.seed ?? 42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const phrase = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const today = opts.today ?? iso(Date.now());
  const thisYear = Number(today.slice(0, 4));

  db.exec('BEGIN');
  try {
    dropOldScratchTables(db);
    const removed = removeTestHistory(db);
    if (Number(db.selectValue('SELECT count(*) FROM account')) === 0) seedDefaultChart(db);
    const cash = ids(db, `detail_type IN ('bank', 'credit_card', 'cash_on_hand')`);
    const income = ids(db, `type = 'income'`);
    const expense = ids(db, `type = 'expense'`);
    if (!cash.length || !income.length || !expense.length) {
      throw new Error(
        'The technical test needs at least one bank or card account, one income account and one expense account.',
      );
    }

    let entries = 0;
    let lines = 0;
    for (let y = thisYear - opts.years + 1; y <= thisYear; y++) {
      const first = Date.UTC(y, 0, 1);
      const last = Math.min(Date.UTC(y, 11, 31), Date.parse(`${today}T00:00:00Z`));
      const days = Math.floor((last - first) / DAY_MS) + 1;
      for (let e = 0; e < opts.entriesPerYear; e++) {
        const date = iso(first + Math.floor(rand() * days) * DAY_MS);
        // A quarter are deposits of income, the rest payments split over 1–4 expenses
        const deposit = rand() < 0.25;
        const parts = deposit ? 1 + Math.floor(rand() * 2) : 1 + Math.floor(rand() * 4);
        const split: EntryLineInput[] = [];
        let total = 0;
        for (let s = 0; s < parts; s++) {
          const cents = deposit
            ? 50_000 + Math.floor(rand() * 450_000)
            : 500 + Math.floor(rand() * 250_000);
          total += cents;
          split.push({
            accountId: pick(deposit ? income : expense),
            debit: deposit ? 0 : cents,
            credit: deposit ? cents : 0,
            memo: phrase(3),
          });
        }
        const money: EntryLineInput = {
          accountId: pick(cash),
          debit: deposit ? total : 0,
          credit: deposit ? 0 : total,
        };
        postEntry(db, {
          date,
          ref: String(1000 + e),
          name: pick(PAYEES),
          memo: phrase(3),
          sourceType: TEST_HISTORY_SOURCE,
          lines: [money, ...split],
        });
        entries++;
        lines += parts + 1;
      }
    }
    recordEvent(
      db,
      'test_history',
      `${removed.toLocaleString('en-US')} made-up entries replaced by ${entries.toLocaleString('en-US')}`,
    );
    db.exec('COMMIT');
    return { removed, entries, lines };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function ms(fn: () => void): number {
  const start = performance.now();
  fn();
  return Math.round((performance.now() - start) * 10) / 10;
}

/** How long the real reports take on this company's books. */
export function measureQueries(db: Database, today = iso(Date.now())): QueryTimings {
  const year = Number(today.slice(0, 4)) - 1;
  const report = (req: ReportRequest) => () => void runReport(db, req);
  return {
    plOneYearMs: ms(report({ kind: 'pl', from: `${year}-01-01`, to: `${year}-12-31` })),
    plAllYearsMs: ms(report({ kind: 'pl', from: null, to: today })),
    balanceSheetMs: ms(report({ kind: 'bs', to: today })),
    trialBalanceMs: ms(report({ kind: 'tb', to: today })),
  };
}

/** Size of SQLite's WebAssembly memory: the main memory cost of an open company. */
export function wasmHeapBytes(sqlite3: Sqlite3Static): number {
  return sqlite3.wasm.heap8u().byteLength;
}
