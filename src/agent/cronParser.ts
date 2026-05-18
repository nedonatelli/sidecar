// ---------------------------------------------------------------------------
// Minimal cron expression parser — no external dependencies.
//
// Supports standard 5-field cron: "minute hour day month weekday"
// Each field accepts: * | number | */step | n-m | n,m,... (and combinations)
//
// Only used by the Scheduler to check whether the current wall-clock time
// matches a cron expression. Called once per minute by a setInterval tick.
// ---------------------------------------------------------------------------

type CronField = (minute: number) => boolean;

function parseField(raw: string, min: number, max: number): CronField {
  if (raw === '*') return () => true;

  const matchers: Array<(n: number) => boolean> = [];

  for (const part of raw.split(',')) {
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (!isNaN(step) && step > 0) {
        matchers.push((n) => (n - min) % step === 0);
        continue;
      }
    }
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map((s) => parseInt(s, 10));
      if (!isNaN(lo) && !isNaN(hi)) {
        matchers.push((n) => n >= lo && n <= hi);
        continue;
      }
    }
    const exact = parseInt(part, 10);
    if (!isNaN(exact) && exact >= min && exact <= max) {
      matchers.push((n) => n === exact);
    }
  }

  if (matchers.length === 0) return () => false;
  return (n) => matchers.some((m) => m(n));
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
}

/**
 * Parse a 5-field cron expression. Returns null if the expression is malformed.
 */
export function parseCron(expr: string): ParsedCron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;
  return {
    minute: parseField(minuteRaw, 0, 59),
    hour: parseField(hourRaw, 0, 23),
    day: parseField(dayRaw, 1, 31),
    month: parseField(monthRaw, 1, 12),
    weekday: parseField(weekdayRaw, 0, 6),
  };
}

/**
 * Returns true if the given Date matches the parsed cron expression.
 * Month is 1-indexed (as cron requires); weekday 0 = Sunday.
 */
export function cronMatches(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minute(date.getMinutes()) &&
    cron.hour(date.getHours()) &&
    cron.day(date.getDate()) &&
    cron.month(date.getMonth() + 1) &&
    cron.weekday(date.getDay())
  );
}
