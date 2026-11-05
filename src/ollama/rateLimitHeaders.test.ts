import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseAnthropicRateLimitHeaders,
  parseOpenAIRateLimitHeaders,
  parseOpenAIDuration,
} from './rateLimitHeaders.js';

describe('parseOpenAIDuration', () => {
  it('parses simple seconds', () => {
    expect(parseOpenAIDuration('30s')).toBe(30);
  });
  it('parses minutes + seconds', () => {
    expect(parseOpenAIDuration('1m30s')).toBe(90);
  });
  it('parses hours + minutes + seconds', () => {
    expect(parseOpenAIDuration('1h30m15s')).toBe(5415);
  });
  it('parses millisecond durations as a 1s floor', () => {
    // OpenAI sometimes emits `500ms` — we don't track sub-second
    // precision, so floor it to 1.
    expect(parseOpenAIDuration('500ms')).toBe(1);
  });
  it('parses minutes alone', () => {
    expect(parseOpenAIDuration('5m')).toBe(300);
  });
  it('parses hours alone', () => {
    expect(parseOpenAIDuration('2h')).toBe(7200);
  });
  // #420: the integer-only pattern read `7.66s` as 66 s and `2m59.56s` as
  // 176 s, past the 60 s wait cap, so every Groq request after the first threw.
  it('parses decimal durations as Groq and OpenAI send them', () => {
    expect(parseOpenAIDuration('7.66s')).toBe(8);
    expect(parseOpenAIDuration('2m59.56s')).toBe(180);
    expect(parseOpenAIDuration('6.857s')).toBe(7);
    expect(parseOpenAIDuration('250ms')).toBe(1);
    expect(parseOpenAIDuration('1.5ms')).toBe(1);
    expect(parseOpenAIDuration('6m0s')).toBe(360);
  });
  it('returns undefined for an unparseable string', () => {
    expect(parseOpenAIDuration('never')).toBeUndefined();
  });
  it('returns undefined for an empty string', () => {
    expect(parseOpenAIDuration('')).toBeUndefined();
  });
});

describe('parseAnthropicRateLimitHeaders', () => {
  // Freeze time so ISO-timestamp → seconds-until calculations are stable
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty update when no headers present', () => {
    const h = new Headers();
    const result = parseAnthropicRateLimitHeaders(h);
    expect(result).toEqual({
      tokensLimit: undefined,
      tokensRemaining: undefined,
      tokensResetSec: undefined,
      requestsLimit: undefined,
      requestsRemaining: undefined,
      requestsResetSec: undefined,
    });
  });

  it('parses a complete header set', () => {
    const h = new Headers({
      'anthropic-ratelimit-tokens-limit': '50000',
      'anthropic-ratelimit-tokens-remaining': '49850',
      'anthropic-ratelimit-tokens-reset': '2026-04-13T12:00:45Z',
      'anthropic-ratelimit-requests-limit': '50',
      'anthropic-ratelimit-requests-remaining': '49',
      'anthropic-ratelimit-requests-reset': '2026-04-13T12:00:10Z',
    });
    const result = parseAnthropicRateLimitHeaders(h);
    expect(result.tokensLimit).toBe(50000);
    expect(result.tokensRemaining).toBe(49850);
    expect(result.tokensResetSec).toBe(45);
    expect(result.requestsLimit).toBe(50);
    expect(result.requestsRemaining).toBe(49);
    expect(result.requestsResetSec).toBe(10);
  });

  it('clamps past reset timestamps to 0', () => {
    const h = new Headers({
      // 10 seconds in the past relative to our frozen clock
      'anthropic-ratelimit-tokens-reset': '2026-04-13T11:59:50Z',
    });
    const result = parseAnthropicRateLimitHeaders(h);
    expect(result.tokensResetSec).toBe(0);
  });

  it('returns undefined for malformed reset timestamps', () => {
    const h = new Headers({
      'anthropic-ratelimit-tokens-reset': 'not-a-date',
    });
    const result = parseAnthropicRateLimitHeaders(h);
    expect(result.tokensResetSec).toBeUndefined();
  });

  it('returns undefined for non-numeric integer headers', () => {
    const h = new Headers({
      'anthropic-ratelimit-tokens-limit': 'abc',
    });
    const result = parseAnthropicRateLimitHeaders(h);
    expect(result.tokensLimit).toBeUndefined();
  });
});

describe('parseOpenAIRateLimitHeaders', () => {
  it('returns empty update when no headers present', () => {
    const h = new Headers();
    const result = parseOpenAIRateLimitHeaders(h);
    expect(result.tokensLimit).toBeUndefined();
    expect(result.tokensRemaining).toBeUndefined();
    expect(result.tokensResetSec).toBeUndefined();
  });

  it('parses a complete header set with mixed duration formats', () => {
    const h = new Headers({
      'x-ratelimit-limit-tokens': '30000',
      'x-ratelimit-remaining-tokens': '29850',
      'x-ratelimit-reset-tokens': '1m30s',
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '55',
      'x-ratelimit-reset-requests': '5s',
    });
    const result = parseOpenAIRateLimitHeaders(h);
    expect(result.tokensLimit).toBe(30000);
    expect(result.tokensRemaining).toBe(29850);
    expect(result.tokensResetSec).toBe(90);
    expect(result.requestsLimit).toBe(60);
    expect(result.requestsRemaining).toBe(55);
    expect(result.requestsResetSec).toBe(5);
  });

  it('parses a Groq header set with decimal resets (#420)', () => {
    const h = new Headers({
      'x-ratelimit-limit-requests': '14400',
      'x-ratelimit-limit-tokens': '18000',
      'x-ratelimit-remaining-requests': '14370',
      'x-ratelimit-remaining-tokens': '17997',
      'x-ratelimit-reset-requests': '2m59.56s',
      'x-ratelimit-reset-tokens': '7.66s',
    });
    const result = parseOpenAIRateLimitHeaders(h);
    expect(result.requestsResetSec).toBe(180);
    expect(result.tokensResetSec).toBe(8);
  });

  it('returns undefined for an unparseable duration string', () => {
    const h = new Headers({
      'x-ratelimit-reset-tokens': '???',
    });
    const result = parseOpenAIRateLimitHeaders(h);
    expect(result.tokensResetSec).toBeUndefined();
  });
});
