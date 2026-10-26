// M1 technical test only: synthetic history and query timings at 17-year size.
// The spike_* tables are throwaway; the real ledger schema arrives in M3.
// Remove this file (and its UI) once docs/spikes/M1-results.md is written.

import type { Database, Sqlite3Static } from './sqlite';

export interface GenerateOptions {
  years: number;
  entriesPerYear: number;
  seed?: number;
}

export interface QueryTimings {
  plOneYearMs: number;
  plAllYearsMs: number;
  trialBalanceMs: number;
}

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spike_account (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS spike_entry (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, ref TEXT, memo TEXT, source_type TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS spike_line (
  id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
  debit INTEGER NOT NULL, credit INTEGER NOT NULL, name TEXT, memo TEXT) STRICT;
`;

const ACCOUNT_TYPES: [string, number][] = [
  ['asset', 12],
  ['liability', 8],
  ['equity', 3],
  ['income', 10],
  ['expense', 55],
];

const WORDS =
  'office supplies rent utilities consulting fees software travel meals insurance repairs fuel parking deposit payment invoice refund'.split(
    ' ',
  );

export function generateHistory(
  db: Database,
  opts: GenerateOptions,
): { entries: number; lines: number } {
  const rand = mulberry32(opts.seed ?? 42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const phrase = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');

  db.exec(SCHEMA);
  db.exec('BEGIN');
  try {
    if (db.selectValue('SELECT count(*) FROM spike_account') === 0) {
      const ins = db.prepare('INSERT INTO spike_account (name, type) VALUES (?, ?)');
      for (const [type, n] of ACCOUNT_TYPES) {
        for (let i = 1; i <= n; i++) ins.bind([`${type} ${i}`, type]).stepReset();
      }
      ins.finalize();
    }
    const accounts = db.selectArrays('SELECT id FROM spike_account').map((r) => Number(r[0]));
    const insEntry = db.prepare(
      'INSERT INTO spike_entry (date, ref, memo, source_type) VALUES (?, ?, ?, ?) RETURNING id',
    );
    const insLine = db.prepare(
      'INSERT INTO spike_line (entry_id, account_id, debit, credit, name, memo) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const lastYear = new Date().getFullYear();
    let entries = 0;
    let lines = 0;
    for (let y = lastYear - opts.years + 1; y <= lastYear; y++) {
      for (let e = 0; e < opts.entriesPerYear; e++) {
        const date = `${y}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`;
        insEntry.bind([date, String(1000 + e), phrase(3), 'qbo_migration']);
        insEntry.step();
        const entryId = Number(insEntry.get(0));
        insEntry.reset();
        // One balancing line against 1–5 split lines, all in integer cents
        const splits = 1 + Math.floor(rand() * 5);
        const debitSide = rand() < 0.5;
        let total = 0;
        for (let s = 0; s < splits; s++) {
          const cents = 100 + Math.floor(rand() * 250_000);
          total += cents;
          insLine
            .bind([
              entryId,
              pick(accounts),
              debitSide ? cents : 0,
              debitSide ? 0 : cents,
              phrase(2),
              phrase(4),
            ])
            .stepReset();
        }
        insLine
          .bind([
            entryId,
            pick(accounts),
            debitSide ? 0 : total,
            debitSide ? total : 0,
            phrase(2),
            null,
          ])
          .stepReset();
        entries++;
        lines += splits + 1;
      }
    }
    insEntry.finalize();
    insLine.finalize();
    db.exec('COMMIT');
    return { entries, lines };
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

const PL = `
SELECT a.type, a.name, sum(l.credit - l.debit) AS amount
FROM spike_line l
JOIN spike_entry e ON e.id = l.entry_id
JOIN spike_account a ON a.id = l.account_id
WHERE e.date BETWEEN ? AND ? AND a.type IN ('income', 'expense')
GROUP BY a.id ORDER BY a.type, a.name`;

const TRIAL_BALANCE = `
SELECT a.name, sum(l.debit) AS debit, sum(l.credit) AS credit
FROM spike_line l
JOIN spike_entry e ON e.id = l.entry_id
JOIN spike_account a ON a.id = l.account_id
WHERE e.date <= ?
GROUP BY a.id`;

export function measureQueries(db: Database): QueryTimings {
  const year = new Date().getFullYear() - 1;
  return {
    plOneYearMs: ms(() => db.selectArrays(PL, [`${year}-01-01`, `${year}-12-31`])),
    plAllYearsMs: ms(() => db.selectArrays(PL, ['1900-01-01', '2999-12-31'])),
    trialBalanceMs: ms(() => db.selectArrays(TRIAL_BALANCE, ['2999-12-31'])),
  };
}

export function createIndexes(db: Database): number {
  return ms(() =>
    db.exec(`
      CREATE INDEX IF NOT EXISTS spike_entry_date ON spike_entry (date);
      CREATE INDEX IF NOT EXISTS spike_line_entry ON spike_line (entry_id);
      CREATE INDEX IF NOT EXISTS spike_line_account ON spike_line (account_id, entry_id);
      ANALYZE;`),
  );
}

export function dropIndexes(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS spike_entry_date;
    DROP INDEX IF EXISTS spike_line_entry;
    DROP INDEX IF EXISTS spike_line_account;`);
}

/** Size of SQLite's WebAssembly memory: the main memory cost of an open company. */
export function wasmHeapBytes(sqlite3: Sqlite3Static): number {
  return sqlite3.wasm.heap8u().byteLength;
}
