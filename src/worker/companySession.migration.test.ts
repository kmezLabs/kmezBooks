// The QuickBooks import through the session, as the worker runs it (M5).

import { describe, expect, it } from 'vitest';
import { exportFiles, type FxCompany } from '../modules/migration/testing/qboFixtures';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

const COMPANY: FxCompany = {
  company: 'Sample Holdings LLC',
  accounts: [
    { name: 'Checking', type: 'Bank', detail: 'Checking' },
    { name: 'Owner Capital', type: 'Equity', detail: "Owner's Equity" },
    { name: 'Retained Earnings', type: 'Equity', detail: 'Retained Earnings' },
    { name: 'Rent Income', type: 'Income', detail: 'Service/Fee Income' },
  ],
  before: [
    {
      date: '2024-06-01',
      type: 'Deposit',
      lines: [
        { account: 'Checking', debit: 500_00 },
        { account: 'Owner Capital', credit: 500_00 },
      ],
    },
  ],
  years: [
    {
      from: '2025-01-01',
      to: '2025-12-31',
      txns: [
        {
          date: '2025-02-01',
          type: 'Deposit',
          name: 'Tenant',
          lines: [
            { account: 'Checking', debit: 1_200_00, memo: 'February rent' },
            { account: 'Rent Income', credit: 1_200_00, memo: 'February rent' },
          ],
        },
      ],
    },
  ],
};

/** A folder holding the exports, the way the owner keeps them. */
async function exportsFolder(): Promise<FakeDir> {
  const root = new FakeDir('QBO');
  for (const f of exportFiles(COMPANY)) {
    const parts = f.path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
    await w.write(f.bytes as Uint8Array<ArrayBuffer>);
    await w.close();
  }
  await (await root.getFileHandle('notes.txt', { create: true })).createWritable();
  return root;
}

async function emptyCompany() {
  const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
  await session.create(
    asDir(new FakeDir()),
    { ...ACME, standardChart: false },
    'the passphrase',
    'PC',
  );
  await session.save();
  return session;
}

describe('session: QuickBooks import (MG-2, MG-4, MG-6)', () => {
  it('reads a folder of exports, dry runs without unsaved changes, then imports', async () => {
    const session = await emptyCompany();
    const plan = await session.migrationAnalyze(asDir(await exportsFolder()));
    expect(plan.summary.errors).toEqual([]);
    expect(plan.companyHasTransactions).toBe(false);
    expect(plan.summary.files.filter((f) => f.kind).length).toBe(7);

    const progress: number[] = [];
    const dry = session.migrationRun(plan.choices, { commit: false }, (done) =>
      progress.push(done),
    );
    expect(dry).toMatchObject({ committed: false, errors: [], tieOut: { ok: true } });
    expect(progress.at(-1)).toBe(1);
    expect(session.entries()).toEqual([]);
    expect(session.status().dirty).toBe(false);

    const done = session.migrationRun(plan.choices, { commit: true });
    expect(done.committed).toBe(true);
    expect(session.status().dirty).toBe(true);
    expect(session.entries().map((e) => [e.date, e.name])).toEqual([
      ['2025-02-01', 'Tenant'],
      ['2024-12-31', null],
    ]);
    // The exports are forgotten once imported
    expect(() => session.migrationRun(plan.choices, { commit: true })).toThrow(/exports first/);
  });

  it('says when the company already has transactions', async () => {
    const session = await emptyCompany();
    const plan = await session.migrationAnalyze(asDir(await exportsFolder()));
    session.migrationRun(plan.choices, { commit: true });
    const again = await session.migrationAnalyze(asDir(await exportsFolder()));
    expect(again.companyHasTransactions).toBe(true);
    expect(again.choices['Checking']).toMatchObject({ kind: 'existing' });
  });
});
