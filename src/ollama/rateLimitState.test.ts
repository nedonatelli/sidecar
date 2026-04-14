import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitStore, maybeWaitForRateLimit, RateLimitWaitTooLongError } from './rateLimitState.js';

describe('RateLimitStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null snapshot before any update', () => {
    const s = new RateLimitStore();
    expect(s.getSnapshot()).toBeNull();
    expect(s.describe()).toBeNull();
  });

  it('ignores completely empty updates', () => {
    const s = new RateLimitStore();
    s.update({});
    expect(s.getSnapshot()).toBeNull();
  });

  it('stores a first update and timestamps it', () => {
    const s = new RateLimitStore();
    s.update({ tokensLimit: 50000, tokensRemaining: 49000, tokensResetSec: 45 });
    const snap = s.getSnapshot();
    expect(snap?.tokensLimit).toBe(50000);
    expect(snap?.tokensRemaining).toBe(49000);
    expect(snap?.updatedAt).toBe(Date.now());
  });

  it('merges partial updates without clearing earlier fields', () => {
    const s = new RateLimitStore();
    s.update({ tokensLimit: 50000, tokensRemaining: 49000 });
    s.update({ requestsLimit: 50, requestsRemaining: 48 });
    const snap = s.getSnapshot();
    expect(snap?.tokensLimit).toBe(50000);
    expect(snap?.requestsLimit).toBe(50);
    expect(snap?.requestsRemaining).toBe(48);
  });

  describe('waitMs', () => {
    it('returns 0 when the store is empty', () => {
      const s = new RateLimitStore();
      expect(s.waitMs(10000)).toBe(0);
    });

    it('returns 0 when remaining covers the request', () => {
      const s = new RateLimitStore();
      s.update({ tokensRemaining: 5000, tokensResetSec: 30 });
      expect(s.waitMs(100)).toBe(0);
    });

    it('returns a positive wait when tokensRemaining is insufficient', () => {
      const s = new RateLimitStore();
      s.update({ tokensRemaining: 100, tokensResetSec: 30 });
      // 30s reset + 1s safety margin = 31000ms
      expect(s.waitMs(5000)).toBe(31000);
    });

    it('returns a positive wait when requestsRemaining is 0', () => {
      const s = new RateLimitStore();
      s.update({ requestsRemaining: 0, requestsResetSec: 10 });
      expect(s.waitMs(100)).toBe(11000);
    });

    it('accounts for elapsed time since the snapshot was captured', () => {
      const s = new RateLimitStore();
      s.update({ tokensRemaining: 100, tokensResetSec: 30 });
      // 20 seconds pass — reset should now be 10s away, plus 1s margin
      vi.advanceTimersByTime(20_000);
      expect(s.waitMs(5000)).toBe(11000);
    });

    it('returns 0 when the reset has already passed since capture', () => {
      const s = new RateLimitStore();
      s.update({ tokensRemaining: 100, tokensResetSec: 30 });
      vi.advanceTimersByTime(40_000);
      // Reset is 10s in the past; no wait required even though
      // tokensRemaining still says 100 (the server will replenish).
      expect(s.waitMs(5000)).toBe(0);
    });

    it('picks the larger blocker when both buckets are exhausted', () => {
      const s = new RateLimitStore();
      s.update({ tokensRemaining: 0, tokensResetSec: 5, requestsRemaining: 0, requestsResetSec: 20 });
      // Takes the longer of the two + safety margin
      expect(s.waitMs(1000)).toBe(21000);
    });
  });

  describe('describe', () => {
    it('formats tokens and requests as used/limit (progress-bar convention)', () => {
      const s = new RateLimitStore();
      s.update({
        tokensLimit: 50000,
        tokensRemaining: 49850,
        tokensResetSec: 45,
        requestsLimit: 50,
        requestsRemaining: 49,
      });
      const desc = s.describe();
      // 50000 - 49850 = 150 used, 50 - 49 = 1 used
      expect(desc).toContain('150/50,000 tokens');
      expect(desc).toContain('1/50 requests');
      expect(desc).toContain('reset in 45s');
    });

    it('shows the blocking bucket reset when tokens are near-exhausted', () => {
      const s = new RateLimitStore();
      s.update({
        tokensLimit: 200000,
        tokensRemaining: 7902,
        tokensResetSec: 617,
        requestsLimit: 500,
        requestsRemaining: 499,
        requestsResetSec: 1,
      });
      const desc = s.describe();
      // Tokens are the real blocker (~96% used, reset in 617s), so the
      // displayed reset should reflect that — not the non-blocking
      // requests bucket's 1s reset.
      expect(desc).toContain('192,098/200,000 tokens');
      expect(desc).toContain('1/500 requests');
      expect(desc).toContain('reset in 617s');
    });

    it('falls back to the sooner reset when neither bucket is near-exhausted', () => {
      const s = new RateLimitStore();
      s.update({
        tokensLimit: 50000,
        tokensRemaining: 45000,
        tokensResetSec: 60,
        requestsLimit: 50,
        requestsRemaining: 45,
        requestsResetSec: 10,
      });
      expect(s.describe()).toContain('reset in 10s');
    });
  });

  it('reset() clears the snapshot', () => {
    const s = new RateLimitStore();
    s.update({ tokensLimit: 50000 });
    s.reset();
    expect(s.getSnapshot()).toBeNull();
  });
});

describe('maybeWaitForRateLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately when no wait is needed', async () => {
    const s = new RateLimitStore();
    await expect(maybeWaitForRateLimit(s, 1000, 60_000)).resolves.toBeUndefined();
  });

  it('waits the computed time and resolves', async () => {
    const s = new RateLimitStore();
    s.update({ tokensRemaining: 100, tokensResetSec: 5 });
    const p = maybeWaitForRateLimit(s, 5000, 60_000);
    // 5s reset + 1s margin = 6000ms
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toBeUndefined();
  });

  it('throws RateLimitWaitTooLongError when the wait exceeds the cap', async () => {
    const s = new RateLimitStore();
    s.update({ tokensRemaining: 100, tokensResetSec: 120 });
    await expect(maybeWaitForRateLimit(s, 5000, 60_000)).rejects.toBeInstanceOf(RateLimitWaitTooLongError);
  });

  it('rejects with AbortError when the signal fires during the wait', async () => {
    const s = new RateLimitStore();
    s.update({ tokensRemaining: 100, tokensResetSec: 10 });
    const ctrl = new AbortController();
    const p = maybeWaitForRateLimit(s, 5000, 60_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
