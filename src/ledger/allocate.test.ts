import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateProRata } from './allocate';

const cents = fc.integer({ min: -1_000_000_00, max: 1_000_000_00 });
const weights = fc
  .array(fc.integer({ min: -500_000_00, max: 500_000_00 }), { minLength: 1, maxLength: 12 })
  .filter((ws) => ws.reduce((a, b) => a + b, 0) !== 0);

describe('allocateProRata (CLAUDE.md rule 5, GL-8)', () => {
  it('splits a partial payment over invoice lines', () => {
    // $100 paid on a $300 invoice of $100 + $200
    expect(allocateProRata(100_00, [100_00, 200_00])).toEqual([33_33, 66_67]);
  });

  it('pays every line in full when the payment equals the document total', () => {
    expect(allocateProRata(275_50, [100_00, 200_00, -24_50])).toEqual([100_00, 200_00, -24_50]);
  });

  it('gives leftover cents to the lines that lost most to rounding, earliest first on ties', () => {
    expect(allocateProRata(1_00, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProRata(2, [1, 1, 1])).toEqual([1, 1, 0]);
  });

  it('handles refunds (negative payments) and discount lines', () => {
    expect(allocateProRata(-50_00, [100_00, 100_00])).toEqual([-25_00, -25_00]);
    expect(allocateProRata(90_00, [100_00, -10_00])).toEqual([100_00, -10_00]);
  });

  it('refuses lines that add up to zero, and fractions of a cent', () => {
    expect(() => allocateProRata(10, [5, -5])).toThrow(/zero/);
    expect(() => allocateProRata(1.5, [1])).toThrow(/whole cents/);
  });

  it('always adds up to the payment exactly', () => {
    fc.assert(
      fc.property(cents, weights, (amount, ws) => {
        const parts = allocateProRata(amount, ws);
        expect(parts).toHaveLength(ws.length);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
        expect(parts.every(Number.isSafeInteger)).toBe(true);
      }),
    );
  });

  it('keeps each part within one cent of its exact share', () => {
    fc.assert(
      fc.property(cents, weights, (amount, ws) => {
        const total = ws.reduce((a, b) => a + b, 0);
        allocateProRata(amount, ws).forEach((part, i) => {
          // |part - amount*w/total| < 1, checked without floats: |part*total - amount*w| < |total|
          const diff = BigInt(part) * BigInt(total) - BigInt(amount) * BigInt(ws[i]!);
          expect(diff < 0n ? -diff : diff).toBeLessThan(BigInt(Math.abs(total)));
        });
      }),
    );
  });

  it('reproduces the lines exactly when the payment equals their total', () => {
    fc.assert(
      fc.property(weights, (ws) => {
        expect(
          allocateProRata(
            ws.reduce((a, b) => a + b, 0),
            ws,
          ),
        ).toEqual(ws);
      }),
    );
  });
});
