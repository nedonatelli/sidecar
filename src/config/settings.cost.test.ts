import { describe, it, expect } from 'vitest';
import { estimateCost, clampMin } from './settings.js';

describe('estimateCost', () => {
  it('calculates cost for Claude Opus', () => {
    const cost = estimateCost('claude-opus-4-6', 10000, 5000);
    expect(cost).not.toBeNull();
    // Opus: $15/M input + $75/M output
    expect(cost).toBeCloseTo((10000 * 15 + 5000 * 75) / 1_000_000);
  });

  it('calculates cost for Claude Sonnet', () => {
    const cost = estimateCost('claude-sonnet-4-6', 10000, 5000);
    expect(cost).not.toBeNull();
    // Sonnet: $3/M input + $15/M output
    expect(cost).toBeCloseTo((10000 * 3 + 5000 * 15) / 1_000_000);
  });

  it('calculates cost for Claude Haiku', () => {
    const cost = estimateCost('claude-haiku-4-5', 10000, 5000);
    expect(cost).not.toBeNull();
    // Haiku: $0.8/M input + $4/M output
    expect(cost).toBeCloseTo((10000 * 0.8 + 5000 * 4) / 1_000_000);
  });

  it('returns null for unknown models', () => {
    expect(estimateCost('llama3', 10000, 5000)).toBeNull();
    expect(estimateCost('gpt-4', 10000, 5000)).toBeNull();
  });

  it('matches partial model names', () => {
    // Model names like "claude-sonnet-4-6:latest" should still match
    expect(estimateCost('models/claude-sonnet-4-6', 1000, 500)).not.toBeNull();
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost('claude-sonnet-4-6', 0, 0)).toBe(0);
  });
});

describe('clampMin', () => {
  it('returns value when above minimum', () => {
    expect(clampMin(10, 5, 0)).toBe(10);
  });

  it('clamps to minimum', () => {
    expect(clampMin(3, 5, 0)).toBe(5);
  });

  it('returns fallback for undefined', () => {
    expect(clampMin(undefined, 5, 10)).toBe(10);
  });

  it('returns fallback for NaN', () => {
    expect(clampMin(NaN, 5, 10)).toBe(10);
  });

  it('returns fallback for non-number types', () => {
    expect(clampMin('hello' as unknown as number, 5, 10)).toBe(10);
  });
});
