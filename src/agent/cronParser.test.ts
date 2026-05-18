import { describe, it, expect } from 'vitest';
import { parseCron, cronMatches } from './cronParser.js';

function date(minute: number, hour: number, day: number, month: number, weekday: number): Date {
  // Use 2024-01-01 as a Monday (weekday=1) anchor; offset day/month as needed.
  // We only care that getMinutes/getHours/getDate/getMonth/getDay return the
  // values we specify — fake with a direct Date constructor.
  const d = new Date(2024, month - 1, day, hour, minute, 0, 0);
  // Override getDay since we can't control it without a real calendar fixture.
  // Wrap Date to inject weekday.
  Object.defineProperty(d, 'getDay', { value: () => weekday });
  return d;
}

describe('parseCron', () => {
  it('returns null for wrong field count', () => {
    expect(parseCron('* * * *')).toBeNull();
    expect(parseCron('* * * * * *')).toBeNull();
    expect(parseCron('')).toBeNull();
  });

  it('parses wildcard expression', () => {
    const cron = parseCron('* * * * *');
    expect(cron).not.toBeNull();
  });
});

describe('cronMatches', () => {
  it('matches all times with * * * * *', () => {
    const cron = parseCron('* * * * *')!;
    expect(cronMatches(cron, date(30, 14, 15, 6, 3))).toBe(true);
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(true);
  });

  it('matches exact minute', () => {
    const cron = parseCron('30 * * * *')!;
    expect(cronMatches(cron, date(30, 8, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(31, 8, 1, 1, 0))).toBe(false);
  });

  it('matches exact hour', () => {
    const cron = parseCron('0 9 * * *')!;
    expect(cronMatches(cron, date(0, 9, 1, 1, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 10, 1, 1, 1))).toBe(false);
  });

  it('matches step expression */15', () => {
    const cron = parseCron('*/15 * * * *')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(15, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(30, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(45, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(7, 0, 1, 1, 0))).toBe(false);
  });

  it('matches range expression 9-17', () => {
    const cron = parseCron('0 9-17 * * *')!;
    expect(cronMatches(cron, date(0, 9, 1, 1, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 17, 1, 1, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 8, 1, 1, 1))).toBe(false);
    expect(cronMatches(cron, date(0, 18, 1, 1, 1))).toBe(false);
  });

  it('matches list expression 1,3,5', () => {
    const cron = parseCron('0 0 * * 1,3,5')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 1))).toBe(true); // Monday
    expect(cronMatches(cron, date(0, 0, 1, 1, 3))).toBe(true); // Wednesday
    expect(cronMatches(cron, date(0, 0, 1, 1, 5))).toBe(true); // Friday
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(false); // Sunday
    expect(cronMatches(cron, date(0, 0, 1, 1, 2))).toBe(false); // Tuesday
  });

  it('matches specific day of month', () => {
    const cron = parseCron('0 0 1 * *')!;
    expect(cronMatches(cron, date(0, 0, 1, 3, 1))).toBe(true);
    expect(cronMatches(cron, date(0, 0, 2, 3, 1))).toBe(false);
  });

  it('matches specific month', () => {
    const cron = parseCron('0 0 1 1 *')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(true);
    expect(cronMatches(cron, date(0, 0, 1, 2, 0))).toBe(false);
  });

  it('ignores unknown field syntax gracefully', () => {
    const cron = parseCron('abc * * * *')!;
    expect(cronMatches(cron, date(0, 0, 1, 1, 0))).toBe(false);
  });
});
