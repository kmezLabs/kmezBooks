import { describe, expect, it } from 'vitest';
import { ledgerEvents, type LedgerEventDetail } from '../ledger/events';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

describe('session: transactions register (GL-9) and changing posted entries (GL-6)', () => {
  it('adds, corrects or changes, and deletes, announcing each', async () => {
    const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
    await session.create(asDir(new FakeDir()), ACME, 'the passphrase', 'PC');
    const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const seen: string[] = [];
    const listen = (e: Event) =>
      seen.push(`${e.type}:${(e as CustomEvent<LedgerEventDetail>).detail.sourceType}`);
    for (const t of ['posted', 'voided', 'changed', 'deleted'])
      ledgerEvents.addEventListener(t, listen);
    try {
      const simple = (cents: number) => ({
        kind: 'expense' as const,
        moneyAccountId: id('Checking'),
        lines: [{ accountId: id('Utilities'), amount: cents, memo: null }],
      });
      const first = await session.addRegisterEntry(simple(45_00), {
        date: '2026-01-05',
        name: 'Power Co',
      });
      expect(session.register().rows).toMatchObject([
        { id: first, name: 'Power Co', expense: 45_00, sourceType: 'register' },
      ]);

      // By default a change is a correction: void and a new entry
      expect(session.postedEdits()).toBe(false);
      const corrected = await session.saveSimpleEntry(first, simple(50_00), {
        date: '2026-01-05',
        name: 'Power Co',
      });
      expect(corrected).not.toBe(first);
      expect(session.entry(first)!.status).toBe('void');
      await expect(session.deleteEntry(corrected)).rejects.toThrow(
        'can’t be deleted in this company',
      );

      // Allowing changes needs the passphrase
      await expect(session.setPostedEdits(true)).rejects.toMatchObject({
        name: 'WrongPassphraseError',
      });
      await expect(session.setPostedEdits(true, 'wrong')).rejects.toMatchObject({
        name: 'WrongPassphraseError',
      });
      await session.setPostedEdits(true, 'the passphrase');
      expect(session.postedEdits()).toBe(true);
      const same = await session.saveSimpleEntry(corrected, simple(55_00), {
        date: '2026-01-06',
        name: 'Power Co',
      });
      expect(same).toBe(corrected);
      expect(session.entry(corrected)).toMatchObject({ date: '2026-01-06', amount: 55_00 });
      await session.deleteEntry(corrected);
      expect(session.entry(corrected)).toBeNull();
      await session.setPostedEdits(false);
      expect(session.audit().some((e) => e.entity === 'company' && e.action === 'update')).toBe(
        true,
      );

      expect(seen).toEqual([
        'posted:register',
        'voided:register',
        'posted:register',
        'changed:register',
        'deleted:register',
      ]);
    } finally {
      for (const t of ['posted', 'voided', 'changed', 'deleted'])
        ledgerEvents.removeEventListener(t, listen);
      await session.discard();
    }
  });
});

describe('session: bank and card registers (GL-12) and transfers (GL-13)', () => {
  it('pays the card from checking as one transfer, shown in both registers', async () => {
    const session = new CompanySession({ iterations: 1_000, heartbeatMs: 0, saveDelayMs: 10_000 });
    await session.create(asDir(new FakeDir()), ACME, 'the passphrase', 'PC');
    const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
    const seen: string[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent<LedgerEventDetail>).detail.sourceType);
    ledgerEvents.addEventListener('posted', listen);
    let transfer: number;
    try {
      await session.addRegisterEntry(
        {
          kind: 'expense',
          moneyAccountId: id('Credit Card'),
          lines: [{ accountId: id('Meals'), amount: 60_00, memo: null }],
        },
        { date: '2026-01-05', name: 'Diner' },
      );
      transfer = await session.addRegisterEntry(
        {
          kind: 'transfer',
          moneyAccountId: id('Checking'),
          lines: [{ accountId: id('Credit Card'), amount: 60_00, memo: null }],
        },
        { date: '2026-01-20', memo: 'Card payment' },
      );
    } finally {
      ledgerEvents.removeEventListener('posted', listen);
    }
    expect(seen).toEqual(['register', 'register']);
    expect(session.moneyAccounts('card')).toMatchObject([{ name: 'Credit Card', balance: 0 }]);
    expect(session.moneyAccounts('bank').find((a) => a.name === 'Checking')?.balance).toBe(-60_00);
    const card = session.register({
      scope: 'all',
      accountId: id('Credit Card'),
      balanceAccountId: id('Credit Card'),
      order: 'asc',
    });
    expect(card.rows.map((r) => [r.otherSide, r.accountAmount, r.balance])).toEqual([
      ['Meals', -60_00, -60_00],
      ['Checking', 60_00, 0],
    ]);
    // Not income or an expense
    expect(session.register().rows.some((r) => r.id === transfer)).toBe(false);
  });
});
