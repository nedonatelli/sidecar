import { describe, it, expect, vi } from 'vitest';
import { estimateCost, clampMin, _resetUnknownModelWarnings } from './settings.js';

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
    _resetUnknownModelWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(estimateCost('llama3', 10000, 5000)).toBeNull();
      expect(estimateCost('totally-made-up-model', 10000, 5000)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('matches partial model names', () => {
    // Model names like "claude-sonnet-4-6:latest" should still match
    expect(estimateCost('models/claude-sonnet-4-6', 1000, 500)).not.toBeNull();
  });

  it('prices new OpenAI models from modelCosts.json', () => {
    expect(estimateCost('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.15 + 0.6);
    expect(estimateCost('gpt-4o', 1_000_000, 1_000_000)).toBeCloseTo(2.5 + 10);
    expect(estimateCost('gpt-5-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.25 + 2);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateCost('claude-sonnet-4-6', 0, 0)).toBe(0);
  });

  it('warns exactly once per unknown model', () => {
    _resetUnknownModelWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      estimateCost('unknown-model-alpha', 100, 100);
      estimateCost('unknown-model-alpha', 200, 200);
      estimateCost('unknown-model-alpha', 300, 300);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("unknown model 'unknown-model-alpha'");

      estimateCost('unknown-model-beta', 100, 100);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
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
