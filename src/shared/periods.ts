// Report periods (RP-3). Dates are YYYY-MM-DD strings; all arithmetic is on
// year/month/day numbers, so time zones never shift a day. Quarters and years
// follow the company's fiscal year.

export const RANGE_PRESETS = {
  this_month: 'This month',
  this_quarter: 'This quarter',
  this_year_to_date: 'This year to date',
  this_year: 'This year',
  last_month: 'Last month',
  last_quarter: 'Last quarter',
  last_year: 'Last year',
  custom: 'Custom dates',
} as const;
export type RangePreset = keyof typeof RANGE_PRESETS;

export const AS_OF_PRESETS = {
  today: 'Today',
  end_of_last_month: 'End of last month',
  end_of_last_quarter: 'End of last quarter',
  end_of_last_year: 'End of last year',
  custom: 'Custom date',
} as const;
export type AsOfPreset = keyof typeof AS_OF_PRESETS;

export interface DateRange {
  from: string;
  to: string;
}

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Month index counted from year 0, so adding months is plain arithmetic. */
const toIndex = (y: number, m: number) => y * 12 + (m - 1);
const fromIndex = (i: number) => ({ y: Math.floor(i / 12), m: (i % 12) + 1 });

function monthRange(startIndex: number, months: number): DateRange {
  const a = fromIndex(startIndex);
  const b = fromIndex(startIndex + months - 1);
  return { from: iso(a.y, a.m, 1), to: iso(b.y, b.m, daysInMonth(b.y, b.m)) };
}

function parts(date: string) {
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) };
}

/** Index of the first month of the fiscal year containing `date`. */
function fiscalYearIndex(date: string, startMonth: number): number {
  const { y, m } = parts(date);
  return toIndex(m >= startMonth ? y : y - 1, startMonth);
}

function fiscalQuarterIndex(date: string, startMonth: number): number {
  const { y, m } = parts(date);
  const fy = fiscalYearIndex(date, startMonth);
  return fy + Math.floor((toIndex(y, m) - fy) / 3) * 3;
}

export function rangeFor(
  preset: Exclude<RangePreset, 'custom'>,
  today: string,
  fyStartMonth = 1,
): DateRange {
  const { y, m } = parts(today);
  const month = toIndex(y, m);
  const quarter = fiscalQuarterIndex(today, fyStartMonth);
  const year = fiscalYearIndex(today, fyStartMonth);
  switch (preset) {
    case 'this_month':
      return monthRange(month, 1);
    case 'this_quarter':
      return monthRange(quarter, 3);
    case 'this_year_to_date':
      return { from: monthRange(year, 12).from, to: today };
    case 'this_year':
      return monthRange(year, 12);
    case 'last_month':
      return monthRange(month - 1, 1);
    case 'last_quarter':
      return monthRange(quarter - 3, 3);
    case 'last_year':
      return monthRange(year - 12, 12);
  }
}

export function asOfFor(
  preset: Exclude<AsOfPreset, 'custom'>,
  today: string,
  fyStartMonth = 1,
): string {
  switch (preset) {
    case 'today':
      return today;
    case 'end_of_last_month':
      return rangeFor('last_month', today, fyStartMonth).to;
    case 'end_of_last_quarter':
      return rangeFor('last_quarter', today, fyStartMonth).to;
    case 'end_of_last_year':
      return rangeFor('last_year', today, fyStartMonth).to;
  }
}

/** The day before `date`. */
export function dayBefore(date: string): string {
  const { y, m, d } = parts(date);
  if (d > 1) return iso(y, m, d - 1);
  const prev = fromIndex(toIndex(y, m) - 1);
  return iso(prev.y, prev.m, daysInMonth(prev.y, prev.m));
}
