// Money is integer cents everywhere (CLAUDE.md rule 9). Parsing and formatting
// work on the digits as text, so no floating-point value ever holds an amount.

export type Cents = number;

/** Largest amount on one line: $100 billion, matching the ledger's CHECK. */
export const MAX_CENTS = 10_000_000_000_000;

/**
 * "1,234.56", "$1234.5", "-12", "(12.00)" → cents. Blank → 0.
 * Returns null for anything that isn't an amount with at most two decimals.
 */
export function parseMoney(text: string): Cents | null {
  let t = text.trim().replaceAll(',', '').replaceAll('$', '').replaceAll(' ', '');
  if (t === '') return 0;
  let negative = false;
  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1);
  }
  if (t.startsWith('-')) {
    negative = !negative;
    t = t.slice(1);
  }
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[1] === '' && !m[2])) return null;
  const cents = BigInt(m[1] || '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  if (cents > BigInt(MAX_CENTS)) return null;
  const n = Number(cents);
  return negative && n !== 0 ? -n : n;
}

/** 123456 → "1,234.56"; negatives as "-1,234.56". */
export function formatMoney(cents: Cents): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`Not an amount in cents: ${cents}`);
  const digits = String(Math.abs(cents)).padStart(3, '0');
  const dollars = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}${dollars}.${digits.slice(-2)}`;
}

/** Sum of cents, checked to stay a safe integer. */
export function sumCents(values: readonly Cents[]): Cents {
  const total = values.reduce((a, b) => a + BigInt(b), 0n);
  const n = Number(total);
  if (!Number.isSafeInteger(n)) throw new Error('Total is too large');
  return n;
}
