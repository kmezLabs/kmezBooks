import { beforeEach, describe, expect, it } from 'vitest';
import { accountId, newLedgerDb, post } from '../../db/tests/ledgerTestDb';
import type { Database } from '../worker/sqlite';
import { trialBalance } from './balances';
import { deleteEntry, voidEntry } from './postEntry';
import {
  CATCH_UP_LIMIT,
  createRecurring,
  deleteRecurring,
  firstDate,
  getRecurring,
  listRecurring,
  nextDate,
  postDue,
  postNow,
  RECURRING_SOURCE,
  setRecurringActive,
  skipNext,
  updateRecurring,
  type RecurringInput,
} from './recurring';

let db: Database;
beforeEach(async () => {
  db = await newLedgerDb();
});

/** Monthly depreciation, booked on the 1st as QuickBooks companies do. */
const depreciation = (extra: Partial<RecurringInput> = {}): RecurringInput => ({
  name: 'Depreciation',
  frequency: 'monthly',
  dayOfMonth: 1,
  startDate: '2026-01-01',
  endDate: null,
  ref: null,
  payee: null,
  memo: null,
  lines: [
    { accountId: accountId(db, 'Depreciation'), debit: 1250_00, credit: 0, memo: null },
    { accountId: accountId(db, 'Accumulated Depreciation'), debit: 0, credit: 1250_00, memo: null },
  ],
  ...extra,
});

const balance = (name: string, asOf = '2026-12-31') => {
  const r = trialBalance(db, asOf).rows.find((x) => x.accountId === accountId(db, name));
  return r ? r.debit - r.credit : 0;
};
const entries = () =>
  db
    .selectObjects(
      `SELECT date, status, memo FROM journal_entry WHERE source_type = 'recurring' ORDER BY date, id`,
    )
    .map((r) => `${String(r.date)} ${String(r.status)}`);

describe('recurring entries: the schedule (GL-5)', () => {
  it('steps by month, quarter or year, on the day or the month’s last day', () => {
    expect(nextDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28');
    expect(nextDate('2026-02-28', 'monthly', 31)).toBe('2026-03-31');
    expect(nextDate('2028-01-30', 'monthly', 30)).toBe('2028-02-29');
    expect(nextDate('2026-11-15', 'quarterly', 15)).toBe('2027-02-15');
    expect(nextDate('2026-01-01', 'yearly', 1)).toBe('2027-01-01');
    expect(firstDate('2026-01-01', 1)).toBe('2026-01-01');
    expect(firstDate('2026-01-02', 1)).toBe('2026-02-01');
    expect(firstDate('2026-02-10', 31)).toBe('2026-02-28');
  });
});

describe('recurring entries: posting (GL-5)', () => {
  it('posts every date that has come, each on its own date, once', () => {
    const id = createRecurring(db, depreciation());
    expect(getRecurring(db, id)).toMatchObject({ nextDate: '2026-01-01', amount: 1250_00 });
    const r = postDue(db, '2026-03-15');
    expect(r.posted.map((p) => p.date)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(r.waiting).toEqual([]);
    expect(entries()).toEqual(['2026-01-01 posted', '2026-02-01 posted', '2026-03-01 posted']);
    expect(balance('Depreciation')).toBe(3 * 1250_00);
    expect(getRecurring(db, id)).toMatchObject({
      nextDate: '2026-04-01',
      lastPosted: '2026-03-01',
    });
    // Again the same day: nothing more
    expect(postDue(db, '2026-03-15').posted).toEqual([]);
    const row = db.selectObjects(
      `SELECT source_type, source_id, memo FROM journal_entry ORDER BY id LIMIT 1`,
    )[0];
    expect(row).toEqual({ source_type: RECURRING_SOURCE, source_id: id, memo: 'Depreciation' });
  });

  it('says so when more dates were due than one go posts', () => {
    const id = createRecurring(db, depreciation({ startDate: '2020-01-01' }));
    const r = postDue(db, '2026-01-15');
    expect(r.posted).toHaveLength(CATCH_UP_LIMIT);
    expect(r.waiting).toEqual([
      expect.objectContaining({
        recurringId: id,
        date: '2023-01-01',
        reason: expect.stringMatching(/Post due now/),
      }),
    ]);
    expect(postDue(db, '2026-01-15').posted.at(-1)!.date).toBe('2025-12-01');
    expect(postDue(db, '2026-01-15')).toMatchObject({
      posted: [{ date: '2026-01-01' }],
      waiting: [],
    });
  });

  it('stops at the end date, and skips inactive templates', () => {
    const id = createRecurring(db, depreciation({ endDate: '2026-02-15' }));
    expect(postDue(db, '2026-12-31').posted).toHaveLength(2);
    expect(getRecurring(db, id).nextDate).toBeNull();
    const other = createRecurring(db, depreciation({ name: 'Amortization' }));
    setRecurringActive(db, other, false);
    expect(postDue(db, '2026-12-31').posted).toEqual([]);
  });

  it('never posts into a closed period on its own: it waits, with the reason', () => {
    db.exec(`UPDATE company SET closing_date = '2026-01-31'`);
    const id = createRecurring(db, depreciation());
    const r = postDue(db, '2026-02-10');
    expect(r.posted).toEqual([]);
    expect(r.waiting).toEqual([
      {
        recurringId: id,
        name: 'Depreciation',
        date: '2026-01-01',
        reason: 'the date is in a closed period',
      },
    ]);
    // With the owner's override it posts, and the rest follow
    postNow(db, id, { closingOverride: true });
    expect(postDue(db, '2026-02-10').posted.map((p) => p.date)).toEqual(['2026-02-01']);
  });

  it('waits when an account is inactive, then carries on once it is active', () => {
    const id = createRecurring(db, depreciation());
    db.exec({
      sql: 'UPDATE account SET active = 0 WHERE id = ?',
      bind: [accountId(db, 'Depreciation')],
    });
    expect(postDue(db, '2026-01-05').waiting[0]).toMatchObject({
      recurringId: id,
      reason: 'this account is inactive',
    });
    db.exec({
      sql: 'UPDATE account SET active = 1 WHERE id = ?',
      bind: [accountId(db, 'Depreciation')],
    });
    expect(postDue(db, '2026-01-05').posted).toHaveLength(1);
  });

  it('skips a date, and an edit keeps what was posted and skipped', () => {
    const id = createRecurring(db, depreciation());
    postDue(db, '2026-01-05');
    skipNext(db, id);
    expect(getRecurring(db, id).nextDate).toBe('2026-03-01');
    updateRecurring(db, id, {
      ...depreciation(),
      lines: depreciation().lines.map((l) => ({
        ...l,
        debit: l.debit && 2500_00,
        credit: l.credit && 2500_00,
      })),
    });
    expect(getRecurring(db, id)).toMatchObject({ nextDate: '2026-03-01', amount: 2500_00 });
    // A new day of the month moves the next date to that day
    updateRecurring(db, id, depreciation({ dayOfMonth: 15 }));
    expect(getRecurring(db, id).nextDate).toBe('2026-03-15');
  });

  it('a voided or deleted entry doesn’t post again; a template that posted stays', () => {
    db.exec('UPDATE company SET posted_edits = 1');
    const id = createRecurring(db, depreciation());
    const [jan, feb] = postDue(db, '2026-02-05').posted;
    voidEntry(db, jan!.entryId, null);
    deleteEntry(db, feb!.entryId);
    expect(postDue(db, '2026-02-05').posted).toEqual([]);
    expect(() => deleteRecurring(db, id)).toThrow('make it inactive');
    const unused = createRecurring(db, depreciation({ name: 'Unused', startDate: '2027-01-01' }));
    deleteRecurring(db, unused);
    expect(listRecurring(db).map((r) => r.name)).toEqual(['Depreciation']);
  });

  it('refuses templates that wouldn’t post', () => {
    expect(() => createRecurring(db, depreciation({ name: ' ' }))).toThrow('name');
    expect(() =>
      createRecurring(db, depreciation({ lines: depreciation().lines.slice(0, 1) })),
    ).toThrow('two lines');
    expect(() =>
      createRecurring(db, depreciation({ startDate: '2026-02-01', endDate: '2026-01-01' })),
    ).toThrow('end date');
    expect(() => createRecurring(db, depreciation({ dayOfMonth: 0 }))).toThrow('day');
  });

  it('a payee on the template names each entry (GL-11)', () => {
    createRecurring(db, depreciation({ payee: 'Westair', ref: 'DEP' }));
    post(db, '2025-12-01', 'Meals', 'Checking', 1_00);
    postDue(db, '2026-01-01');
    expect(
      db.selectObjects(`SELECT name, ref FROM journal_entry WHERE source_type = 'recurring'`),
    ).toEqual([{ name: 'Westair', ref: 'DEP' }]);
  });
});
