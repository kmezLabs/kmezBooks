// Report timings on a full-size company posted through postEntry() (triggers
// and audit log included). Opt-in: REPORT_BENCH=1 npx vitest run db/tests/reports.bench.test.ts --silent=false
import { it } from 'vitest';
import { postEntry } from '../../src/ledger/postEntry';
import { dropAuditTriggers } from '../../src/worker/audit';
import { runReport } from '../../src/ledger/reports';
import { accountId, newLedgerDb } from './ledgerTestDb';

it.runIf(process.env.REPORT_BENCH)(
  'reports over 17 years × 6,000 entries',
  async () => {
    const db = await newLedgerDb();
    // REPORT_NO_AUDIT=1 measures the same data without per-row audit entries
    if (process.env.REPORT_NO_AUDIT) dropAuditTriggers(db);
    const names = [
      'Checking',
      'Savings',
      'Credit Card',
      'Sales',
      'Services',
      'Meals',
      'Travel',
      'Rent or Lease',
      'Utilities',
      'Office Supplies and Software',
    ];
    const ids = names.map((n) => accountId(db, n));
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const time = (fn: () => unknown) => {
      const t = performance.now();
      fn();
      return Math.round(performance.now() - t);
    };
    const years = 17;
    const perYear = Number(process.env.REPORT_PER_YEAR ?? 6000);
    const postMs = time(() => {
      db.exec('BEGIN');
      for (let y = 2026 - years + 1; y <= 2026; y++) {
        for (let i = 0; i < perYear; i++) {
          const date = `${y}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')}`;
          const splits = 1 + Math.floor(rand() * 3);
          const lines = [];
          let total = 0;
          for (let s = 0; s < splits; s++) {
            const cents = 100 + Math.floor(rand() * 200_000);
            total += cents;
            lines.push({ accountId: ids[3 + Math.floor(rand() * 7)]!, debit: cents, credit: 0 });
          }
          lines.push({ accountId: ids[Math.floor(rand() * 3)]!, debit: 0, credit: total });
          postEntry(db, { date, sourceType: 'journal', memo: 'benchmark entry', lines });
        }
      }
      db.exec('COMMIT');
    });
    const checking = accountId(db, 'Checking');
    const results = {
      entries: years * perYear,
      postAllMs: postMs,
      dbMB: Math.round(
        (Number(db.selectValue('PRAGMA page_count')) * Number(db.selectValue('PRAGMA page_size'))) /
          1e6,
      ),
      auditRows: Number(db.selectValue('SELECT count(*) FROM audit_event')),
      plOneYearMs: time(() => runReport(db, { kind: 'pl', from: '2025-01-01', to: '2025-12-31' })),
      plAllYearsMs: time(() => runReport(db, { kind: 'pl', from: null, to: '2026-12-31' })),
      balanceSheetMs: time(() => runReport(db, { kind: 'bs', to: '2026-06-30' })),
      trialBalanceMs: time(() => runReport(db, { kind: 'tb', to: '2026-06-30' })),
      glOneAccountOneYearMs: time(() =>
        runReport(db, { kind: 'gl', from: '2025-01-01', to: '2025-12-31', accountId: checking }),
      ),
      glAllAccountsOneMonthMs: time(() =>
        runReport(db, { kind: 'gl', from: '2025-03-01', to: '2025-03-31' }),
      ),
    };
    console.table(results);
  },
  900_000,
);
