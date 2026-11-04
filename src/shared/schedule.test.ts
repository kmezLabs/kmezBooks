import { describe, expect, it } from 'vitest';
import { describeSchedule, upcomingDate, type Schedule } from './schedule';

describe('describing a schedule (GL-5)', () => {
  it.each([
    [1, 'Monthly on the 1st'],
    [2, 'Monthly on the 2nd'],
    [3, 'Monthly on the 3rd'],
    [4, 'Monthly on the 4th'],
    [11, 'Monthly on the 11th'],
    [12, 'Monthly on the 12th'],
    [13, 'Monthly on the 13th'],
    [21, 'Monthly on the 21st'],
    [22, 'Monthly on the 22nd'],
    [23, 'Monthly on the 23rd'],
    [30, 'Monthly on the 30th'],
    [31, 'Monthly on the last day'],
  ])('day %i: "%s"', (day, text) => {
    expect(describeSchedule('monthly', day, '2026-01-01')).toBe(text);
  });

  it('names the month for a yearly schedule, from its start date', () => {
    expect(describeSchedule('quarterly', 15, '2026-01-15')).toBe('Quarterly on the 15th');
    expect(describeSchedule('yearly', 15, '2026-03-15')).toBe('Yearly on Mar 15');
    expect(describeSchedule('yearly', 31, '2026-12-31')).toBe('Yearly on the last day of Dec');
  });
});

describe('the next date a schedule falls on (GL-5)', () => {
  const monthly: Schedule = {
    frequency: 'monthly',
    dayOfMonth: 31,
    startDate: '2026-01-15',
    endDate: '2026-04-30',
  };

  it('starts on the first scheduled date on or after the start date', () => {
    expect(upcomingDate(monthly, null, null)).toBe('2026-01-31');
  });

  it('moves past the last date done, keeping the month end', () => {
    expect(upcomingDate(monthly, '2026-01-31', null)).toBe('2026-02-28');
    expect(upcomingDate(monthly, '2026-02-28', null)).toBe('2026-03-31');
  });

  it('never goes back before a date the owner skipped to', () => {
    expect(upcomingDate(monthly, '2026-01-31', '2026-03-31')).toBe('2026-03-31');
  });

  it('stops after the end date', () => {
    expect(upcomingDate(monthly, '2026-04-30', null)).toBeNull();
    expect(upcomingDate({ ...monthly, endDate: null }, '2026-04-30', null)).toBe('2026-05-31');
  });
});
