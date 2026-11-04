// The lines of a journal entry as typed in a form (GL-4, GL-5, GL-10): amounts
// stay text until saved. Kept free of React and the worker so the round trip
// from a saved entry to the form and back can be tested in Node.

import { formatMoney, parseMoney, type Cents } from '../shared/money';

/** Typed money as cents; blank or unreadable counts as 0 (lineTotals() reports unreadable). */
const cents = (text: string): Cents => parseMoney(text) ?? 0;

export interface LineDraft {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  /** A line's own payee (MG-3), kept from the entry it was filled from */
  name?: string | null;
}

let nextKey = 1;
export const blankLine = (): LineDraft => ({
  key: nextKey++,
  accountId: '',
  debit: '',
  credit: '',
  memo: '',
});

/** Lines of a saved entry or template, ready to edit. */
export function linesFrom(
  lines: {
    accountId: string;
    debit: number;
    credit: number;
    memo: string | null;
    name?: string | null;
  }[],
): LineDraft[] {
  return lines.map((l) => ({
    ...blankLine(),
    accountId: l.accountId,
    debit: l.debit ? formatMoney(l.debit) : '',
    credit: l.credit ? formatMoney(l.credit) : '',
    memo: l.memo ?? '',
    name: l.name,
  }));
}

/** The lines in use, their totals, and whether every amount reads as money. */
export function lineTotals(lines: LineDraft[]) {
  const used = lines.filter((l) => l.accountId || l.debit.trim() || l.credit.trim());
  const debits = used.reduce((s, l) => s + cents(l.debit), 0);
  const credits = used.reduce((s, l) => s + cents(l.credit), 0);
  return {
    used,
    debits,
    credits,
    difference: debits - credits,
    badAmount: lines.some((l) => parseMoney(l.debit) === null || parseMoney(l.credit) === null),
    /** At least two lines, with something on them, that balance */
    balanced: debits - credits === 0 && debits > 0 && used.length >= 2,
  };
}

/** The lines as cents, for saving. */
export const linesToCents = (used: LineDraft[]) =>
  used.map((l) => ({
    accountId: l.accountId,
    debit: cents(l.debit),
    credit: cents(l.credit),
    memo: l.memo,
    name: l.name ?? null,
  }));
