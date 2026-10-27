import { describe, expect, it } from 'vitest';
import { ledgerEvents, type LedgerEventDetail } from '../ledger/events';
import { qboFile } from '../modules/banking/testing/ofxFixtures';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

const statement = (name: string) =>
  new File(
    [
      qboFile({
        end: '2026-01-31',
        balance: '954.90',
        balanceDate: '2026-01-31',
        txns: [
          { fitid: 'J1', date: '2026-01-03', amount: '1000.00', name: 'ACME PAYROLL' },
          { fitid: 'J2', date: '2026-01-05', amount: '-45.10', name: 'CITY POWER' },
        ],
      }),
    ],
    name,
  );

describe('session: banking (BK-1, BK-3, BK-7, BK-8)', () => {
  it('imports a statement file, reviews it, reconciles it and warns about voiding a reconciled entry', async () => {
    const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
    await session.create(asDir(new FakeDir()), ACME, 'the passphrase', 'PC');
    const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const checking = id('Checking');
    const seen: string[] = [];
    const listen = (e: Event) =>
      seen.push(`${e.type}:${(e as CustomEvent<LedgerEventDetail>).detail.sourceType}`);
    ledgerEvents.addEventListener('posted', listen);
    ledgerEvents.addEventListener('voided', listen);
    try {
      expect(session.bankAccounts().map((a) => a.name)).toContain('Checking');
      const read = await session.bankReadStatements([statement('jan.qbo')]);
      expect(read.problems).toEqual([]);
      expect(read.statements).toMatchObject([
        { file: 'jan.qbo', transactions: 2, accountId: null },
      ]);
      expect(() => session.bankImport({})).not.toThrow(); // nothing chosen: nothing imported
      expect(() => session.bankImport({ [read.statements[0]!.key]: checking })).toThrow(
        'Choose the statement files first',
      );

      const again = await session.bankReadStatements([statement('jan.qbo')]);
      const result = session.bankImport({ [again.statements[0]!.key]: checking });
      expect(result.statements).toMatchObject([{ added: 2, duplicates: 0 }]);
      expect(session.status().dirty).toBe(true);
      expect(session.bankAccounts().find((a) => a.id === checking)).toMatchObject({
        waiting: 2,
        feedLabel: 'Checking ••7890',
      });

      const [power, pay] = session.bankQueue(checking);
      await session.bankCategorize(power!.id, {
        lines: [{ accountId: id('Utilities'), amount: 45_10 }],
      });
      const payEntry = await session.bankCategorize(pay!.id, {
        lines: [{ accountId: id('Services'), amount: 1_000_00 }],
      });
      expect(session.entry(payEntry)).toMatchObject({ sourceType: 'bank', reconciled: [] });

      // The statement balance from the file starts the reconciliation
      const state = session.reconcileState(checking);
      expect(state.suggested).toEqual({ statementDate: '2026-01-31', endingBalance: 954_90 });
      const rec = session.reconcileStart(checking, '2026-01-31', 954_90);
      session.reconcileSetAllCleared(rec, true);
      expect(session.reconcileState(checking).difference).toBe(0);
      session.reconcileFinish(rec);
      expect(session.entry(payEntry)!.reconciled).toEqual([
        { account: 'Checking', statementDate: '2026-01-31' },
      ]);
      expect(session.reconcileReport(rec).cleared).toHaveLength(2);

      await session.bankUndo(pay!.id);
      expect(session.bankQueue(checking)).toHaveLength(1);
      expect(session.reconcileHistory(checking)[0]!.changedCount).toBe(1);
      expect(seen).toEqual(['posted:bank', 'posted:bank', 'voided:bank']);
    } finally {
      ledgerEvents.removeEventListener('posted', listen);
      ledgerEvents.removeEventListener('voided', listen);
      await session.discard();
    }
  });
});
