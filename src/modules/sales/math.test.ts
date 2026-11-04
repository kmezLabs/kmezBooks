import { describe, expect, it } from 'vitest';
import { formatQuantity, lineAmount, parseQuantity } from './math';

describe('quantities on invoice lines (AR-4)', () => {
  it.each([
    ['2.5', 2500],
    ['12', 12000],
    ['  3 ', 3000],
    ['0.125', 125],
    ['.5', 500],
    ['7.', 7000],
    ['-1.25', -1250],
    ['0', 0],
  ])('reads "%s" as %i thousandths', (text, thousandths) => {
    expect(parseQuantity(text)).toBe(thousandths);
  });

  it.each(['', '-', '.', '1.2345', '1,000', '1e3', 'two', '1.2.3', '+1'])(
    'refuses "%s"',
    (text) => {
      expect(parseQuantity(text)).toBeNull();
    },
  );

  it('writes quantities back the way they were typed', () => {
    for (const text of ['2.5', '12', '0.125', '-1.25', '0']) {
      expect(formatQuantity(parseQuantity(text)!)).toBe(text);
    }
  });

  it('prices a line from quantity and rate, rounding half away from zero', () => {
    expect(lineAmount(parseQuantity('2.5')!, 10_00)).toBe(25_00);
    expect(lineAmount(parseQuantity('0.333')!, 1_00)).toBe(33);
    expect(lineAmount(parseQuantity('0.005')!, 1_00)).toBe(1);
    expect(lineAmount(parseQuantity('-0.005')!, 1_00)).toBe(-1);
  });
});
