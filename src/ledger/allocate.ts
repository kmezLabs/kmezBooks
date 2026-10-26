// The one way to split a payment over a document's lines (CLAUDE.md rule 5,
// GL-8). Each part is the exact pro-rata share rounded to the cent; leftover
// cents go to the parts that lost most to rounding, so the parts always add up
// to the payment exactly. BigInt throughout, so no amount is ever a float.

import type { Cents } from '../shared/money';

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

/**
 * Split `amount` in proportion to `weights` (the document's line amounts, which
 * may include negative lines such as discounts). The weights must not sum to 0.
 */
export function allocateProRata(amount: Cents, weights: readonly Cents[]): Cents[] {
  if (!Number.isSafeInteger(amount) || weights.some((w) => !Number.isSafeInteger(w))) {
    throw new Error('Amounts must be whole cents');
  }
  const total = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (total === 0n) throw new Error('Cannot split over lines that add up to zero');
  const a = BigInt(amount);
  const sign = total < 0n ? -1n : 1n;
  const exact = weights.map((w) => a * BigInt(w));
  const parts = exact.map((n) => floorDiv(n, total));
  // What each part lost to rounding down, scaled by |total| (always ≥ 0)
  const lost = exact.map((n, i) => (n - parts[i]! * total) * sign);
  let leftover = a - parts.reduce((x, p) => x + p, 0n);
  const order = lost
    .map((l, i) => ({ l, i }))
    .sort((x, y) => (x.l === y.l ? x.i - y.i : x.l > y.l ? -1 : 1));
  for (const { i } of order) {
    if (leftover === 0n) break;
    parts[i]! += 1n;
    leftover -= 1n;
  }
  return parts.map(Number);
}
