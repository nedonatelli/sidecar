import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker, BackendCircuitOpenError } from './circuitBreaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
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
