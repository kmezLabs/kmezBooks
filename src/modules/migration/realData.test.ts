// Dry run against real QuickBooks exports on this computer. Opt-in, and the
// data never enters the repository:
//   QBO_DIR="C:/KM/QBO/Some Company" npx vitest run src/modules/migration/realData.test.ts --silent=false

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { newCompanyDb } from '../../../db/tests/testDb';
import { analyze, type SourceFile } from './analysis';
import { proposeChoices, runImport } from './importer';

function readTree(root: string, dir = root): SourceFile[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return readTree(root, path);
    if (!name.toLowerCase().endsWith('.xlsx')) return [];
    return [{ path: relative(root, path).replaceAll('\\', '/'), bytes: readFileSync(path) }];
  });
}

it.runIf(process.env.QBO_DIR)(
  'analyses and dry-runs the exports in QBO_DIR',
  async () => {
    const t0 = performance.now();
    const analysis = analyze(readTree(process.env.QBO_DIR!));
    const { summary } = analysis;
    console.log(
      JSON.stringify(
        {
          company: summary.company,
          files: summary.files.map((f) => `${f.path}: ${f.label} ${f.period} ${f.basis ?? ''}`),
          periods: summary.periods,
          accounts: summary.accounts.map(
            (a) =>
              `${a.name} → ${a.type}/${a.detailType}${a.inList ? '' : ' (not in list)'}, ${a.lines} lines`,
          ),
          customers: summary.customers,
          vendors: summary.vendors,
          transactions: summary.transactions,
          skipped: summary.skipped,
          opening: summary.opening,
          errors: summary.errors,
          warnings: summary.warnings,
          analyseMs: Math.round(performance.now() - t0),
        },
        null,
        2,
      ),
    );
    const db = await newCompanyDb();
    const t1 = performance.now();
    const result = runImport(db, analysis, proposeChoices(db, summary.accounts), { commit: false });
    console.log(
      JSON.stringify({ ...result, dryRunMs: Math.round(performance.now() - t1) }, null, 2),
    );
    expect(result.errors).toEqual([]);
    expect(result.tieOut?.ok).toBe(true);
    // A dry run leaves nothing behind
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(0);
    expect(db.selectValue('SELECT count(*) FROM account')).toBe(0);
  },
  600_000,
);
