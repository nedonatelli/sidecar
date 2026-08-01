import { describe, it, expect } from 'vitest';
import { isInfraFailure } from './agentHarness.js';

// A full ceiling run reported 16 regressions that were one network blip.
//
// A `fetch failed` was correctly classified as infra — and then SideCar's own
// circuit breaker tripped in response, so every subsequent case died with
// "[SideCar] anthropic backend is temporarily disabled after repeated failures".
// That message matched none of the infra patterns, so the cascade counted as
// case regressions: 54 real passes followed by 16 fabricated failures, in a run
// whose summary read "16 failed | 55 passed" with nothing to distinguish it from
// a genuinely broken suite.
//
// The breaker is infrastructure reporting that infrastructure is down. It must
// never be readable as a model getting worse.

describe('isInfraFailure', () => {
  it.each([
    'fetch failed',
    'request to https://api.anthropic.com failed, reason: ECONNREFUSED',
    'The operation timed out',
    // The cascade this test exists for — see src/ollama/circuitBreaker.ts
    '[SideCar] anthropic backend is temporarily disabled after repeated failures. Retrying in 15s.',
    '[SideCar] ollama backend is temporarily disabled after repeated failures. Retrying in 30s.',
    'terminated',
    'socket hang up',
    '429 Too Many Requests',
    'Overloaded',
  ])('treats %s as infrastructure, not a regression', (message) => {
    expect(isInfraFailure(new Error(message))).toBe(true);
  });

  it.each([
    'search string not found in src/utils.ts',
    'Agent exceeded max iterations',
    'Expected edit_file to be called',
    'syntax error introduced by edit',
  ])('treats %s as a real case failure', (message) => {
    expect(isInfraFailure(new Error(message))).toBe(false);
  });

  it('classifies an AbortError by name, whatever its message says', () => {
    const e = new Error('aborted by user');
    e.name = 'AbortError';
    expect(isInfraFailure(e)).toBe(true);
  });
});
