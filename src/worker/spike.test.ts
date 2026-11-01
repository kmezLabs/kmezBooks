// M1 technical test: made-up history posted into the real ledger (CO-7 test
// companies only). Set SPIKE_FULL=1 to also print a Node baseline at full size.
import { describe, expect, it } from 'vitest';
import { COMPANY_ID, OWNER_ID, insertCompany, newCompanyDb } from '../../db/tests/testDb';
import { seedDefaultChart } from '../ledger/accounts';
import { newLedgerDb, post } from '../../db/tests/ledgerTestDb';
import { register } from '../ledger/register';
import type { Database } from './sqlite';
import { createCompanyKey, decryptDatabase, encryptDatabase } from './kmbFormat';
import { TEST_HISTORY_SOURCE, generateHistory, measureQueries, wasmHeapBytes } from './spike';
import { migrate } from './migrations';
import { MIGRATIONS, applySchema } from './schema';
import { deserializeDatabase, loadSqlite, openEmptyDatabase, serializeDatabase } from './sqlite';

const TODAY = '2026-11-01';

const asTest = <T extends Database>(db: T): T => {
  db.exec('UPDATE company SET test = 1');
  return db;
};
const testLedger = async () => asTest(await newLedgerDb());
const count = (db: Database, sql: string) =>
  Number(db.selectValue(sql, sql.includes('?') ? [TEST_HISTORY_SOURCE] : undefined));
const MADE_UP = `SELECT count(*) FROM journal_entry WHERE source_type = ?`;
// Payees are added the first time a name is used, like anywhere else
const LEDGER_EVENTS = `SELECT count(*) FROM audit_event WHERE entity IS NOT 'payee'`;

describe('M1 made-up history', () => {
  it('posts balanced cash-basis entries that the register shows', async () => {
    const db = await testLedger();
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
    const db = asTest(await newCompanyDb());
    generateHistory(db, { years: 1, entriesPerYear: 10, today: TODAY });
    expect(Number(db.selectValue('SELECT count(*) FROM account'))).toBeGreaterThan(30);
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(10);
  });

  it('drops the scratch tables older runs left behind', async () => {
    const db = await testLedger();
    db.exec('CREATE TABLE spike_entry (id INTEGER PRIMARY KEY) STRICT');
    generateHistory(db, { years: 1, entriesPerYear: 1, today: TODAY });
    expect(db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE name LIKE 'spike_%'`)).toBe(0);
  });

  it("replaces the last run, keeps the owner's own entries, and logs one event a run", async () => {
    const db = await testLedger();
    post(db, '2026-03-01', 'Office Supplies and Software', 'Checking', 12_34);
    generateHistory(db, { years: 1, entriesPerYear: 30, today: TODAY });
    const audited = count(db, LEDGER_EVENTS);
    expect(
      generateHistory(db, { years: 2, entriesPerYear: 20, today: TODAY, seed: 7 }),
    ).toMatchObject({ removed: 30, entries: 40 });
    expect(count(db, MADE_UP)).toBe(40);
    expect(count(db, 'SELECT count(*) FROM journal_entry')).toBe(41);
    // The deleted lines left nothing behind, and every entry still balances
    expect(
      count(
        db,
        'SELECT count(*) FROM journal_line WHERE entry_id NOT IN (SELECT id FROM journal_entry)',
      ),
    ).toBe(0);
    expect(
      count(
        db,
        `SELECT count(*) FROM (SELECT entry_id FROM journal_line GROUP BY entry_id HAVING sum(debit) <> sum(credit))`,
      ),
    ).toBe(0);
    // One audit event for the run, not one per entry posted or deleted
    expect(count(db, LEDGER_EVENTS) - audited).toBe(1);
    expect(db.selectValue('SELECT note FROM audit_event ORDER BY id DESC LIMIT 1')).toBe(
      '30 made-up entries replaced by 40',
    );
  });

  it('sends bank transactions matched to the old history back to review', async () => {
    const db = await testLedger();
    generateHistory(db, { years: 1, entriesPerYear: 5, today: TODAY });
    const e = db.selectObjects(
      `SELECT l.entry_id, l.account_id, l.debit - l.credit AS amount FROM journal_line l
       JOIN journal_entry j ON j.id = l.entry_id JOIN account a ON a.id = l.account_id
       WHERE a.detail_type = 'bank' LIMIT 1`,
    )[0]!;
    db.exec({
      sql: `INSERT INTO bank_import (id, company_id, account_id, file_name, added, duplicates)
            VALUES ('imp', (SELECT id FROM company), ?, 'x.qbo', 1, 0)`,
      bind: [String(e.account_id)],
    });
    db.exec({
      sql: `INSERT INTO bank_txn (company_id, account_id, import_id, fitid, date, amount, payee)
            VALUES ((SELECT id FROM company), ?, 'imp', 'f1', '2026-01-02', ?, 'Shop')`,
      bind: [String(e.account_id), Number(e.amount)],
    });
    db.exec({
      sql: `UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE fitid = 'f1'`,
      bind: [Number(e.entry_id)],
    });
    generateHistory(db, { years: 1, entriesPerYear: 5, today: TODAY, seed: 9 });
    expect(db.selectObjects(`SELECT status, entry_id FROM bank_txn`)).toEqual([
      { status: 'new', entry_id: null },
    ]);
  });

  it('refuses a real company, whose posted entries can never be deleted', async () => {
    const db = await newLedgerDb();
    expect(() => generateHistory(db, { years: 1, entriesPerYear: 1, today: TODAY })).toThrow(
      /only in a test company/,
    );
    const id = post(db, '2026-03-01', 'Office Supplies and Software', 'Checking', 5_00, {
      sourceType: TEST_HISTORY_SOURCE,
    });
    expect(() => db.exec(`DELETE FROM journal_line WHERE entry_id = ${id}`)).toThrow(/GL-6/);
    expect(() => db.exec(`DELETE FROM journal_entry WHERE id = ${id}`)).toThrow(/GL-6/);
    // In a test company, only made-up history can go
    asTest(db);
    const own = post(db, '2026-03-02', 'Office Supplies and Software', 'Checking', 6_00);
    expect(() => db.exec(`DELETE FROM journal_line WHERE entry_id = ${own}`)).toThrow(/GL-6/);
  });

  it('replaces history in a test company made before the delete exception (schema 20)', async () => {
    // An earlier build of CO-7 made test companies with 0020 only
    const db = openEmptyDatabase(await loadSqlite());
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version <= 20),
    );
    db.exec('BEGIN');
    db.exec({
      sql: `INSERT INTO session (id, company_id, user_id, unlocked_at) VALUES (1, ?, ?, 'now')`,
      bind: [COMPANY_ID, OWNER_ID],
    });
    insertCompany(db, { test: 1 });
    db.exec({
      sql: `INSERT INTO app_user (id, company_id, name, role) VALUES (?, ?, 'Owner', 'owner')`,
      bind: [OWNER_ID, COMPANY_ID],
    });
    db.exec('COMMIT');
    seedDefaultChart(db);
    generateHistory(db, { years: 1, entriesPerYear: 10, today: TODAY });
    expect(() => generateHistory(db, { years: 1, entriesPerYear: 10, today: TODAY })).toThrow(
      /GL-6/,
    );
    applySchema(db);
    expect(generateHistory(db, { years: 1, entriesPerYear: 10, today: TODAY })).toMatchObject({
      removed: 10,
      entries: 10,
    });
  });

  it("won't replace made-up history in a closed period", async () => {
    const db = await testLedger();
    generateHistory(db, { years: 1, entriesPerYear: 20, today: TODAY });
    db.exec(`UPDATE company SET closing_date = '2026-06-30'`);
    expect(() => generateHistory(db, { years: 1, entriesPerYear: 20, today: TODAY })).toThrow(
      /closed period/,
    );
    expect(count(db, MADE_UP)).toBe(20);
    const old = db.selectValue(
      `SELECT id FROM journal_entry WHERE source_type = 'test_history' AND date <= '2026-06-30' LIMIT 1`,
    );
    expect(() => db.exec(`DELETE FROM journal_line WHERE entry_id = ${String(old)}`)).toThrow(
      /GL-6/,
    );
  });

  it('posts nothing when an entry is refused (closed period)', async () => {
    const db = await testLedger();
    db.exec(`UPDATE company SET closing_date = '2026-06-30'`);
    expect(() => generateHistory(db, { years: 1, entriesPerYear: 50, today: TODAY })).toThrow();
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(0);
  });

  it.runIf(process.env.SPIKE_FULL)(
    'Node baseline at 17 years (SPIKE_PER_YEAR entries, default 6,000)',
    async () => {
      const sqlite3 = await loadSqlite();
      const db = await testLedger();
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
