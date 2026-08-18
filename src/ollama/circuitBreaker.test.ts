import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker, BackendCircuitOpenError } from './circuitBreaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    // Use a small cooldownMs so timer-based tests stay fast.
    // maxCooldownMs is set high enough that the cap doesn't interfere with
    // the two-trip exponential test (1000 * 2 = 2000 < 8000).
    breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, maxCooldownMs: 8000 });
  });

  describe('closed state', () => {
    it('starts closed and allows requests', () => {
      expect(breaker.allow('openai')).toBe(true);
      expect(breaker.describe('openai').state).toBe('closed');
    });

    it('counts consecutive failures without tripping below threshold', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      expect(breaker.describe('openai').state).toBe('closed');
      expect(breaker.describe('openai').consecutiveFailures).toBe(2);
      expect(breaker.allow('openai')).toBe(true);
    });

    it('resets consecutive failures on success', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordSuccess('openai');
      expect(breaker.describe('openai').consecutiveFailures).toBe(0);
    });
  });

  describe('SIDECAR_DISABLE_CIRCUIT_BREAKER escape hatch', () => {
    afterEach(() => {
      delete process.env.SIDECAR_DISABLE_CIRCUIT_BREAKER;
    });

    it('guard() does not throw even when open (benchmark/cataloging mode)', () => {
      // Trip it open.
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      expect(breaker.describe('openai').state).toBe('open');
      // Normally guard throws while open...
      expect(() => breaker.guard('openai')).toThrow(BackendCircuitOpenError);
      // ...but the escape hatch makes it a no-op so a flaky-but-alive endpoint
      // keeps getting requests instead of fast-failing the whole run.
      process.env.SIDECAR_DISABLE_CIRCUIT_BREAKER = 'true';
      expect(() => breaker.guard('openai')).not.toThrow();
    });
  });

  describe('opening', () => {
    it('trips open after N consecutive failures', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      expect(breaker.describe('openai').state).toBe('open');
      expect(breaker.allow('openai')).toBe(false);
    });

    it('guard() throws BackendCircuitOpenError when open', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      expect(() => breaker.guard('openai')).toThrow(BackendCircuitOpenError);
    });

    it('guard() error carries the TIERED cooldown (not just the base cooldownMs)', () => {
      // Use fake timers so we control when the half-open probe fires.
      vi.useFakeTimers();
      // Trip 1: openCount = 1, tierCooldown = 1000ms (same as base)
      for (let i = 0; i < 3; i++) breaker.recordFailure('openai');
      // Advance past cooldown, probe, fail → Trip 2: openCount = 2, tierCooldown = 2000ms
      vi.advanceTimersByTime(1001);
      breaker.allow('openai'); // probe slot
      breaker.recordFailure('openai'); // probe fails → opens again at doubled cooldown

      // guard() must now throw with cooldownRemainingMs close to 2000ms (tiered),
      // NOT ~1000ms (base). Before the fix, it used `this.cooldownMs` (1000ms here).
      let err: BackendCircuitOpenError | null = null;
      try {
        breaker.guard('openai');
      } catch (e) {
        err = e as BackendCircuitOpenError;
      }
      expect(err).toBeInstanceOf(BackendCircuitOpenError);
      // Tiered value is 2000ms; base is 1000ms.  The remaining time should
      // exceed 1000ms, proving it's using the doubled tier.
      expect(err!.cooldownRemainingMs).toBeGreaterThan(1000);
      expect(err!.cooldownRemainingMs).toBeLessThanOrEqual(2000);
      vi.useRealTimers();
    });
  });

  describe('half-open', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('transitions to half-open after cooldown elapses and allows exactly one probe', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      expect(breaker.allow('openai')).toBe(false);

      vi.advanceTimersByTime(1001);
      // First allow() passes (probe)
      expect(breaker.allow('openai')).toBe(true);
      expect(breaker.describe('openai').state).toBe('half-open');
      // Second call before resolution is rejected
      expect(breaker.allow('openai')).toBe(false);
    });

    it('successful probe closes the breaker', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      vi.advanceTimersByTime(1001);
      breaker.allow('openai'); // probe allowed
      breaker.recordSuccess('openai');
      expect(breaker.describe('openai').state).toBe('closed');
      expect(breaker.allow('openai')).toBe(true);
    });

    it('failed probe reopens with fresh cooldown', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      vi.advanceTimersByTime(1001);
      breaker.allow('openai'); // probe allowed
      breaker.recordFailure('openai');
      expect(breaker.describe('openai').state).toBe('open');
      expect(breaker.describe('openai').cooldownRemainingMs).toBeGreaterThan(900);
    });
  });

  describe('exponential backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('doubles cooldown on each failed probe', () => {
      // Trip 1 — cooldown = 1000ms
      for (let i = 0; i < 3; i++) breaker.recordFailure('openai');
      expect(breaker.describe('openai').cooldownRemainingMs).toBeGreaterThan(900);

      // Advance past first cooldown, let probe fail → Trip 2
      vi.advanceTimersByTime(1001);
      breaker.allow('openai');
      breaker.recordFailure('openai');

      // Cooldown is now doubled (2000ms)
      expect(breaker.describe('openai').cooldownRemainingMs).toBeGreaterThan(1900);

      // The original 1000ms cooldown is not enough to re-enter half-open
      vi.advanceTimersByTime(1001);
      expect(breaker.allow('openai')).toBe(false);

      // But 2000ms total is enough
      vi.advanceTimersByTime(1000);
      expect(breaker.allow('openai')).toBe(true);
    });

    it('resets openCount to 0 after a successful probe', () => {
      for (let i = 0; i < 3; i++) breaker.recordFailure('openai');
      vi.advanceTimersByTime(1001);
      breaker.allow('openai');
      breaker.recordSuccess('openai');

      // Trip again — cooldown should be back to 1000ms (openCount reset)
      for (let i = 0; i < 3; i++) breaker.recordFailure('openai');
      expect(breaker.describe('openai').cooldownRemainingMs).toBeGreaterThan(900);
      expect(breaker.describe('openai').cooldownRemainingMs).toBeLessThanOrEqual(1000);
    });

    it('caps cooldown at maxCooldownMs', () => {
      const capped = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 3000 });
      vi.useFakeTimers();
      // Trip 1 → 1000ms, Trip 2 → 2000ms, Trip 3 → 3000ms (capped), Trip 4 → 3000ms (still capped)
      capped.recordFailure('openai'); // trip 1
      vi.advanceTimersByTime(1001);
      capped.allow('openai');
      capped.recordFailure('openai'); // trip 2
      vi.advanceTimersByTime(2001);
      capped.allow('openai');
      capped.recordFailure('openai'); // trip 3
      vi.advanceTimersByTime(3001);
      capped.allow('openai');
      capped.recordFailure('openai'); // trip 4 — should still be capped
      expect(capped.describe('openai').cooldownRemainingMs).toBeLessThanOrEqual(3000);
    });
  });

  describe('isolation', () => {
    it('keeps providers independent', () => {
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      breaker.recordFailure('openai');
      expect(breaker.allow('anthropic')).toBe(true);
      expect(breaker.describe('anthropic').state).toBe('closed');
    });
  });

  describe('describe', () => {
    it('reports zero cooldown when closed', () => {
      expect(breaker.describe('openai').cooldownRemainingMs).toBe(0);
    });

    it('reports remaining cooldown when open', () => {
      vi.useFakeTimers();
      try {
        breaker.recordFailure('openai');
        breaker.recordFailure('openai');
        breaker.recordFailure('openai');
        vi.advanceTimersByTime(400);
        const remaining = breaker.describe('openai').cooldownRemainingMs;
        expect(remaining).toBeGreaterThan(500);
        expect(remaining).toBeLessThanOrEqual(600);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
