import { describe, expect, it } from 'vitest';
import { ledgerEvents, type LedgerEventDetail } from '../ledger/events';
import { CompanySession } from './companySession';
import { FakeDir, asDir } from './testing/fakeDir';
import { ACME } from './testing/fixtures';

async function companyWithDepreciation() {
  const dir = new FakeDir();
  let t = new Date(2026, 0, 15, 9, 0, 0);
  const session = new CompanySession({
    iterations: 1_000,
    heartbeatMs: 0,
    saveDelayMs: 10_000,
    now: () => t,
  });
  await session.create(asDir(dir), ACME, 'pw', 'PC');
  const id = (name: string) => session.accounts().find((a) => a.name === name)!.id;
  session.createRecurring({
    name: 'Depreciation',
    frequency: 'monthly',
    dayOfMonth: 1,
    startDate: '2026-02-01',
    endDate: null,
    ref: null,
    payee: null,
    memo: null,
    lines: [
      { accountId: id('Depreciation'), debit: 2292_73, credit: 0, memo: null },
      { accountId: id('Accumulated Depreciation'), debit: 0, credit: 2292_73, memo: null },
    ],
  });
  await session.close();
  return { dir, session, advanceTo: (d: Date) => (t = d) };
}

describe('session: recurring entries post when the company opens (GL-5)', () => {
  it('posts what came due while closed, says so until dismissed, and saves', async () => {
    const { dir, session, advanceTo } = await companyWithDepreciation();
    advanceTo(new Date(2026, 3, 10, 9, 0, 0)); // April 10: Feb, Mar and Apr are due
    const seen: string[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent<LedgerEventDetail>).detail.sourceType);
    ledgerEvents.addEventListener('posted', listen);
    try {
      const outcome = await session.open(asDir(dir), 'pw', { device: 'PC' });
      expect(outcome.kind).toBe('opened');
    } finally {
      ledgerEvents.removeEventListener('posted', listen);
    }
    const status = session.status();
    expect(status.recurring?.posted.map((p) => [p.name, p.date])).toEqual([
      ['Depreciation', '2026-02-01'],
      ['Depreciation', '2026-03-01'],
      ['Depreciation', '2026-04-01'],
    ]);
    expect(status.recurring?.waiting).toEqual([]);
    expect(status.dirty).toBe(true);
    expect(seen).toEqual(['recurring', 'recurring', 'recurring']);
    expect(session.recurringList()[0]).toMatchObject({ nextDate: '2026-05-01' });

    session.dismissRecurring();
    expect(session.status().recurring).toBeNull();
    await session.close();

    // Opened again the same day: nothing more, and no notice
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    expect(session.status().recurring).toBeNull();
    expect(session.recurringList()[0]!.lastPosted).toBe('2026-04-01');
  });

  it('posts nothing in a read-only session', async () => {
    const { dir, session, advanceTo } = await companyWithDepreciation();
    advanceTo(new Date(2026, 3, 10, 9, 0, 0));
    await session.open(asDir(dir), 'pw', { device: 'PC', mode: 'readOnly' });
    expect(session.status().recurring).toBeNull();
    expect(session.recurringList()[0]).toMatchObject({ nextDate: '2026-02-01', lastPosted: null });
  });

  it('reports a date waiting in a closed period, and posts it with the passphrase', async () => {
    const { dir, session, advanceTo } = await companyWithDepreciation();
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    session.setClosingDate('2026-02-28');
    await session.close();
    advanceTo(new Date(2026, 2, 5, 9, 0, 0));
    await session.open(asDir(dir), 'pw', { device: 'PC' });
    const waiting = session.status().recurring?.waiting;
    expect(waiting).toEqual([
      expect.objectContaining({ date: '2026-02-01', reason: 'the date is in a closed period' }),
    ]);
    const tid = waiting![0]!.recurringId;
    await expect(session.postRecurringNow(tid)).rejects.toMatchObject({
      name: 'ClosedPeriodError',
    });
    await session.postRecurringNow(tid, 'pw');
    expect(session.postDueRecurring().posted.map((p) => p.date)).toEqual(['2026-03-01']);
  });
});
