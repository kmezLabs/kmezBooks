// M1 technical test: made-up history posted into the real ledger (CO-7 test
// companies only). Set SPIKE_FULL=1 to also print a Node baseline at full size.
import { describe, expect, it } from 'vitest';
import { newCompanyDb } from '../../db/tests/testDb';
import { newLedgerDb } from '../../db/tests/ledgerTestDb';
import { register } from '../ledger/register';
import { createCompanyKey, decryptDatabase, encryptDatabase } from './kmbFormat';
import { TEST_HISTORY_SOURCE, generateHistory, measureQueries, wasmHeapBytes } from './spike';
import { deserializeDatabase, loadSqlite, serializeDatabase } from './sqlite';

const TODAY = '2026-11-01';

describe('M1 made-up history', () => {
  it('posts balanced cash-basis entries that the register shows', async () => {
    const db = await newLedgerDb();
    expect(generateHistory(db, { years: 2, entriesPerYear: 200, today: TODAY })).toMatchObject({
      entries: 400,
    });
    expect(
      db.selectValue(
        `SELECT count(*) FROM journal_entry WHERE status = 'posted' AND source_type = ?`,
        [TEST_HISTORY_SOURCE],
      ),
    ).toBe(400);
    // Every entry moves a bank or card account, and none is dated after today
    expect(
      db.selectValue(`
        SELECT count(*) FROM journal_entry e WHERE NOT EXISTS (
          SELECT 1 FROM journal_line l JOIN account a ON a.id = l.account_id
          WHERE l.entry_id = e.id AND a.detail_type IN ('bank', 'credit_card', 'cash_on_hand'))`),
    ).toBe(0);
    expect(db.selectValue('SELECT max(date) FROM journal_entry')! <= TODAY).toBe(true);
    expect(db.selectValue('SELECT min(date) FROM journal_entry')! >= '2025-01-01').toBe(true);
    expect(register(db).rows.length).toBeGreaterThan(0);
    expect(measureQueries(db, TODAY).plOneYearMs).toBeGreaterThanOrEqual(0);
  });

  it('gives a company with no accounts the standard chart first', async () => {
    const db = await newCompanyDb();
    generateHistory(db, { years: 1, entriesPerYear: 10, today: TODAY });
    expect(Number(db.selectValue('SELECT count(*) FROM account'))).toBeGreaterThan(30);
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(10);
  });

  it('drops the scratch tables older runs left behind', async () => {
    const db = await newLedgerDb();
    db.exec('CREATE TABLE spike_entry (id INTEGER PRIMARY KEY) STRICT');
    generateHistory(db, { years: 1, entriesPerYear: 1, today: TODAY });
    expect(db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE name LIKE 'spike_%'`)).toBe(0);
  });

  it('posts nothing when an entry is refused (closed period)', async () => {
    const db = await newLedgerDb();
    db.exec(`UPDATE company SET closing_date = '2026-06-30'`);
    expect(() => generateHistory(db, { years: 1, entriesPerYear: 50, today: TODAY })).toThrow();
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(0);
  });

  it.runIf(process.env.SPIKE_FULL)(
    'Node baseline at 17 years (SPIKE_PER_YEAR entries, default 6,000)',
    async () => {
      const sqlite3 = await loadSqlite();
      const db = await newLedgerDb();
      const t0 = performance.now();
      const counts = generateHistory(db, {
        years: 17,
        entriesPerYear: Number(process.env.SPIKE_PER_YEAR ?? 6_000),
      });
      const generateMs = performance.now() - t0;
      const timings = measureQueries(db);

      const key = await createCompanyKey('pw');
      const t1 = performance.now();
      const plain = serializeDatabase(sqlite3, db);
      const t2 = performance.now();
      const file = await encryptDatabase(key, plain);
      const t3 = performance.now();
      const back = await decryptDatabase(key, file);
      const t4 = performance.now();
      deserializeDatabase(sqlite3, back).close();
      const t5 = performance.now();

      console.table({
        ...counts,
        dbMB: +(plain.byteLength / 1e6).toFixed(1),
        wasmHeapMB: +(wasmHeapBytes(sqlite3) / 1e6).toFixed(0),
        generateMs: Math.round(generateMs),
        serializeMs: Math.round(t2 - t1),
        encryptMs: Math.round(t3 - t2),
        decryptMs: Math.round(t4 - t3),
        deserializeAndCheckMs: Math.round(t5 - t4),
        ...timings,
      });
    },
    1_800_000,
  );
});
