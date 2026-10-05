import { describe, it, expect, afterEach } from 'vitest';
import { promptDateLine } from './promptDate.js';

afterEach(() => {
  delete process.env.SIDECAR_PROMPT_DATE;
});

describe('promptDateLine', () => {
  it("gives the user's LOCAL date, not UTC's", () => {
    // 01:30 UTC on Oct 6 is still the evening of Oct 5 in New York. A UTC date
    // would tell an evening user it is already tomorrow.
    const line = promptDateLine(new Date('2026-10-06T01:30:00Z'), 'America/New_York');
    expect(line).toContain('2026-10-05');
    expect(line).toContain('Monday, October 5, 2026');
    expect(line).toContain('America/New_York');
  });

  it('carries the date only, never the time of day', () => {
    // A time would change the prompt every minute: no prompt cache hits, and
    // no two eval runs alike. The model can run `date` if it needs the time.
    const line = promptDateLine(new Date('2026-10-05T13:47:12Z'), 'UTC');
    expect(line).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('says what the date is for, and that training data may be older', () => {
    const line = promptDateLine(new Date('2026-10-05T12:00:00Z'), 'UTC');
    expect(line).toMatch(/today/i);
    expect(line).toMatch(/latest|recent/i);
    expect(line).toMatch(/training/i);
  });

  it('is pinned by SIDECAR_PROMPT_DATE, ignoring the clock and timezone, so an eval run stays reproducible', () => {
    process.env.SIDECAR_PROMPT_DATE = '2026-01-15';
    const a = promptDateLine(new Date('2026-10-05T23:59:00Z'), 'Asia/Tokyo');
    const b = promptDateLine(new Date('2027-03-01T00:01:00Z'), 'America/Los_Angeles');
    expect(a).toBe(b);
    expect(a).toContain('2026-01-15');
    expect(a).toContain('Thursday, January 15, 2026');
  });

  it('ignores a malformed pin rather than putting nonsense in the prompt', () => {
    process.env.SIDECAR_PROMPT_DATE = 'next tuesday';
    expect(promptDateLine(new Date('2026-10-05T12:00:00Z'), 'UTC')).toContain('2026-10-05');
  });

  it('falls back to UTC for an unknown timezone rather than throwing', () => {
    expect(() => promptDateLine(new Date('2026-10-05T12:00:00Z'), 'Not/AZone')).not.toThrow();
    expect(promptDateLine(new Date('2026-10-05T12:00:00Z'), 'Not/AZone')).toContain('2026-10-05');
  });
});
