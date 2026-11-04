// The journal entry form's lines (GL-4) and re-entering a voided entry from a
// filled-in copy (GL-10): a saved entry, put in the form and saved again
// unchanged, must post exactly the same lines.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { accountId, newLedgerDb } from '../../db/tests/ledgerTestDb';
import { getEntry } from '../ledger/entries';
import { postEntry, voidEntry } from '../ledger/postEntry';
import { blankLine, lineTotals, linesFrom, linesToCents } from './lineDrafts';

const roundTrip = (lines: Parameters<typeof linesFrom>[0]) =>
  linesToCents(lineTotals([...linesFrom(lines), blankLine()]).used);

describe('the entry form’s lines (GL-4)', () => {
  it('gives back any saved lines unchanged, amounts to the cent', () => {
    const line = fc.record({
      accountId: fc.constantFrom('a1', 'a2', 'a3'),
      amount: fc.integer({ min: 1, max: 99_999_999_999_99 }),
      side: fc.constantFrom('debit', 'credit'),
      memo: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: null }),
      name: fc.option(fc.constantFrom('Acme LLC', 'Power Co'), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 8 }), (drawn) => {
        const lines = drawn.map((l) => ({
          accountId: l.accountId,
          debit: l.side === 'debit' ? l.amount : 0,
          credit: l.side === 'credit' ? l.amount : 0,
          memo: l.memo,
          name: l.name,
        }));
        expect(roundTrip(lines)).toEqual(lines.map((l) => ({ ...l, memo: l.memo ?? '' })));
      }),
    );
  });

  it('says when typed lines balance, and when an amount isn’t money', () => {
    const [a, b] = [blankLine(), blankLine()];
    expect(lineTotals([a, b]).balanced).toBe(false);
    const lines = [
      { ...a, accountId: 'a1', debit: '1,234.50' },
      { ...b, accountId: 'a2', credit: '1234.5' },
    ];
    expect(lineTotals(lines)).toMatchObject({
      debits: 1_234_50,
      credits: 1_234_50,
      balanced: true,
    });
    expect(lineTotals([...lines, { ...blankLine(), debit: 'ten' }]).badAmount).toBe(true);
  });
});

describe('re-entering a voided entry (GL-10)', () => {
  it('posts the filled-in copy with the same lines and keeps the void on record', async () => {
    const db = await newLedgerDb();
    const card = accountId(db, 'Credit Card');
    const id = postEntry(db, {
      date: '2026-03-04',
      ref: 'R-7',
      name: 'Office Depot',
      memo: 'Supplies',
      sourceType: 'journal',
      lines: [
        {
          accountId: accountId(db, 'Office Supplies and Software'),
          debit: 80_01,
          credit: 0,
          memo: 'Paper',
        },
        { accountId: accountId(db, 'Meals'), debit: 19_99, credit: 0, name: 'Cafe' },
        { accountId: card, debit: 0, credit: 100_00 },
      ],
    });
    voidEntry(db, id, 'Wrong card');
    const voided = getEntry(db, id)!;

    // What the form does: fill in from the voided entry, then save as new
    const copy = postEntry(db, {
      date: voided.date,
      ref: voided.ref,
      name: voided.name,
      memo: voided.memo,
      sourceType: 'journal',
      lines: linesToCents(lineTotals(linesFrom(voided.lines)).used),
    });

    const reentered = getEntry(db, copy)!;
    const shape = (e: typeof voided) =>
      e.lines.map((l) => [l.accountId, l.debit, l.credit, l.memo, l.name]);
    expect(reentered.status).toBe('posted');
    expect(shape(reentered)).toEqual(shape(voided));
    expect([reentered.ref, reentered.name, reentered.memo]).toEqual([
      'R-7',
      'Office Depot',
      'Supplies',
    ]);
    expect(getEntry(db, id)).toMatchObject({ status: 'void', voidReason: 'Wrong card' });
  });
});
