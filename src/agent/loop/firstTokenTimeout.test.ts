import { describe, it, expect } from 'vitest';
import { firstTokenTimeoutMsFor } from './firstTokenTimeout.js';
import { FIRST_TOKEN_WARMUP_MS, FIRST_TOKEN_PREFILL_MS_PER_TOKEN } from '../../config/constants.js';

describe('firstTokenTimeoutMsFor', () => {
  const floor = 300_000; // the shipped 300s default, in ms

  it('returns the configured floor for small prompts', () => {
    // A tiny prompt: adaptive term is far below the floor, so the floor wins —
    // tight hang-detection is preserved for everyday requests.
    expect(firstTokenTimeoutMsFor(floor, 100)).toBe(floor);
  });

  it('scales above the floor for large prompts', () => {
    // A 30k-token repo context needs prefill headroom the flat floor can't give.
    const big = firstTokenTimeoutMsFor(floor, 30_000);
    expect(big).toBeGreaterThan(floor);
    expect(big).toBe(FIRST_TOKEN_WARMUP_MS + 30_000 * FIRST_TOKEN_PREFILL_MS_PER_TOKEN);
  });

  it('crosses over from floor to adaptive at the expected input size', () => {
    const crossover = (floor - FIRST_TOKEN_WARMUP_MS) / FIRST_TOKEN_PREFILL_MS_PER_TOKEN;
    expect(firstTokenTimeoutMsFor(floor, Math.floor(crossover) - 1)).toBe(floor);
    expect(firstTokenTimeoutMsFor(floor, Math.ceil(crossover) + 1)).toBeGreaterThan(floor);
  });

  it('honors a raised user floor even when adaptive would be lower', () => {
    // User set a generous 900s; a small prompt must still get their 900s.
    expect(firstTokenTimeoutMsFor(900_000, 100)).toBe(900_000);
  });

  it('preserves 0 = disabled', () => {
    expect(firstTokenTimeoutMsFor(0, 50_000)).toBe(0);
  });

  it('never goes negative on a nonsense token count', () => {
    expect(firstTokenTimeoutMsFor(floor, -5)).toBe(floor);
  });
});
