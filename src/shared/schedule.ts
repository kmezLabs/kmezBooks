// Schedules of recurring entries (GL-5): the dates they fall on and how to
// say them. Shared by the ledger (posting) and the screens (labels, forms).

export type Frequency = 'monthly' | 'quarterly' | 'yearly';

export const FREQUENCIES: Record<Frequency, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

const MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The day in a month, or the month's last day when it has fewer. */
function onDay(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysIn(year, month)))}`;
}

/** The scheduled date after `date`: the same day one period later, clamped to the month's end. */
export function nextDate(date: string, frequency: Frequency, day: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + MONTHS[frequency];
  return onDay(Math.floor(total / 12), (total % 12) + 1, day);
}

/** The first scheduled date on or after the start date. */
export function firstDate(startDate: string, day: number): string {
  const [y, m, d] = startDate.split('-').map(Number) as [number, number, number];
  const inMonth = onDay(y, m, day);
  return Number(inMonth.slice(8)) >= d ? inMonth : nextDate(inMonth, 'monthly', day);
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${n % 10 > 3 ? 'th' : suffix}`;
}

const MONTH_NAMES = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** "Monthly on the 1st", "Quarterly on the last day", "Yearly on Mar 15". */
export function describeSchedule(frequency: Frequency, day: number, startDate: string): string {
  const onThe = day >= 31 ? 'the last day' : `the ${ordinal(day)}`;
  if (frequency === 'yearly') {
    const month = MONTH_NAMES[Number(startDate.slice(5, 7)) - 1] ?? '';
    return `Yearly on ${day >= 31 ? `the last day of ${month}` : `${month} ${day}`}`;
  }
  return `${FREQUENCIES[frequency]} on ${onThe}`;
}

export interface Schedule {
  frequency: Frequency;
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
}

/**
 * A schedule's next date: its first date, or after the last one done, never
 * before `current` (so skipped dates stay skipped). Null once past the end.
 */
export function upcomingDate(
  s: Schedule,
  last: string | null,
  current: string | null,
): string | null {
  let next = firstDate(s.startDate, s.dayOfMonth);
  while ((last && next <= last) || (current && next < current)) {
    next = nextDate(next, s.frequency, s.dayOfMonth);
  }
  return s.endDate && next > s.endDate ? null : next;
}
