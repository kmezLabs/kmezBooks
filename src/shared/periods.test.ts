import { describe, expect, it } from 'vitest';
import { asOfFor, dayBefore, rangeFor } from './periods';

describe('report periods (RP-3)', () => {
  const today = '2026-10-26';

  it.each([
    ['this_month', '2026-10-01', '2026-10-31'],
    ['this_quarter', '2026-10-01', '2026-12-31'],
    ['this_year_to_date', '2026-01-01', '2026-10-26'],
    ['this_year', '2026-01-01', '2026-12-31'],
    ['last_month', '2026-09-01', '2026-09-30'],
    ['last_quarter', '2026-07-01', '2026-09-30'],
    ['last_year', '2025-01-01', '2025-12-31'],
  ] as const)('%s on a calendar year', (preset, from, to) => {
    expect(rangeFor(preset, today)).toEqual({ from, to });
  });

  it('crosses year boundaries in January', () => {
    expect(rangeFor('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(rangeFor('last_quarter', '2026-02-10')).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
  });

  it('knows leap years', () => {
    expect(rangeFor('this_month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
    expect(dayBefore('2026-01-01')).toBe('2025-12-31');
  });

  it('follows a fiscal year that starts in July', () => {
    expect(rangeFor('this_year', today, 7)).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    expect(rangeFor('this_quarter', today, 7)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(rangeFor('last_year', '2026-03-01', 7)).toEqual({
      from: '2024-07-01',
      to: '2025-06-30',
    });
    expect(rangeFor('this_quarter', '2026-08-15', 8)).toEqual({
      from: '2026-08-01',
      to: '2026-10-31',
    });
  });

  it('gives as-of dates for the balance sheet', () => {
    expect(asOfFor('today', today)).toBe(today);
    expect(asOfFor('end_of_last_month', today)).toBe('2026-09-30');
    expect(asOfFor('end_of_last_quarter', today)).toBe('2026-09-30');
    expect(asOfFor('end_of_last_year', today)).toBe('2025-12-31');
  });
});
