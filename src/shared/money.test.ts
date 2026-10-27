import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_CENTS, formatMoney, parseMoney, sumCents } from './money';

describe('money (CLAUDE.md rule 9)', () => {
  it.each([
    ['1,234.56', 123456],
    ['$1234.5', 123450],
    ['0.07', 7],
    ['.5', 50],
    ['12', 1200],
    ['12.', 1200],
    ['-12.34', -1234],
    ['(12.00)', -1200],
    ['  $ 1 000.00 ', 100000],
    ['', 0],
    ['-0', 0],
  ])('parses %j as %i cents', (text, cents) => {
    expect(parseMoney(text)).toBe(cents);
  });

  it.each(['1.234', 'abc', '1.2.3', '--1', '.', '1e5', '100000000000.01'])('rejects %j', (text) => {
    expect(parseMoney(text)).toBeNull();
  });

  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [123456, '1,234.56'],
    [-100, '-1.00'],
    [MAX_CENTS, '100,000,000,000.00'],
  ])('formats %i as %s', (cents, text) => {
    expect(formatMoney(cents)).toBe(text);
  });

  it('round-trips any amount through format and parse', () => {
    fc.assert(
      fc.property(fc.integer({ min: -MAX_CENTS, max: MAX_CENTS }), (cents) => {
        expect(parseMoney(formatMoney(cents))).toBe(cents);
      }),
    );
  });

  it('never produces the classic float error', () => {
    expect(parseMoney('0.1')! + parseMoney('0.2')!).toBe(parseMoney('0.3'));
    expect(sumCents([10, 20])).toBe(30);
  });
});

describe('centsToDecimal', () => {
  it('writes plain decimals for exports', async () => {
    const { centsToDecimal } = await import('./money');
    expect(centsToDecimal(123456789)).toBe('1234567.89');
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(centsToDecimal(0)).toBe('0.00');
  });
});
