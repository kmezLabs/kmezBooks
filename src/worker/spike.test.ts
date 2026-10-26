// M1 spike checks. Set SPIKE_FULL=1 to also print a Node baseline at full size.
import { describe, expect, it } from 'vitest';
import { createCompanyKey, decryptDatabase, encryptDatabase } from './ebkFormat';
import { createIndexes, generateHistory, measureQueries, wasmHeapBytes } from './spike';
import { deserializeDatabase, loadSqlite, openEmptyDatabase, serializeDatabase } from './sqlite';

describe('M1 synthetic history', () => {
  it('generates balanced entries in integer cents', async () => {
    const db = openEmptyDatabase(await loadSqlite());
    expect(generateHistory(db, { years: 2, entriesPerYear: 200 })).toMatchObject({ entries: 400 });
    const unbalanced = db.selectValue(`
      SELECT count(*) FROM (
        SELECT entry_id FROM spike_line GROUP BY entry_id HAVING sum(debit) <> sum(credit))`);
    expect(unbalanced).toBe(0);
    expect(db.selectValue(`SELECT count(*) FROM spike_line WHERE typeof(debit) <> 'integer'`)).toBe(
      0,
    );
    expect(measureQueries(db).plOneYearMs).toBeGreaterThanOrEqual(0);
  });

  it.runIf(process.env.SPIKE_FULL)(
    'Node baseline at 17 years (SPIKE_PER_YEAR entries, default 6,000)',
    async () => {
      const sqlite3 = await loadSqlite();
      const db = openEmptyDatabase(sqlite3);
      const t0 = performance.now();
      const counts = generateHistory(db, {
        years: 17,
        entriesPerYear: Number(process.env.SPIKE_PER_YEAR ?? 6_000),
      });
      const generateMs = performance.now() - t0;
      const noIndex = measureQueries(db);
      const indexMs = createIndexes(db);
      const withIndex = measureQueries(db);

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
        indexMs,
        ...Object.fromEntries(Object.entries(noIndex).map(([k, v]) => [`${k}_noIndex`, v])),
        ...withIndex,
      });
    },
    600_000,
  );
});
