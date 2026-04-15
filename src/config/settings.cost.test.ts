import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  estimateCost,
  clampMin,
  _resetUnknownModelWarnings,
  _resetRuntimeModelCosts,
  registerModelCost,
  ingestOpenRouterCatalog,
} from './settings.js';

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

describe('runtime model cost overlay', () => {
  beforeEach(() => {
    _resetRuntimeModelCosts();
    _resetUnknownModelWarnings();
  });

  it('registerModelCost exposes a previously unknown model', () => {
    // Sanity check — the id is not in the static table.
    const before = estimateCost('anthropic/claude-sonnet-4.5', 1_000_000, 1_000_000);
    expect(before).toBeNull();

    registerModelCost('anthropic/claude-sonnet-4.5', { input: 3, output: 15 });
    const after = estimateCost('anthropic/claude-sonnet-4.5', 1_000_000, 1_000_000);
    expect(after).toBeCloseTo(3 + 15);
  });

  it('runtime overlay wins over substring match against the static table', () => {
    // The static table has claude-haiku-4-5 at $0.8 / $4.
    // A runtime override should take precedence even though the substring
    // match would also hit.
    registerModelCost('claude-haiku-4-5', { input: 99, output: 99 });
    const cost = estimateCost('claude-haiku-4-5', 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(99 + 99);
  });

  it('ingestOpenRouterCatalog registers pricing in per-1M-token units', () => {
    const registered = ingestOpenRouterCatalog([
      // $3 / $15 per M expressed as OpenRouter strings: per-single-token.
      { id: 'anthropic/claude-sonnet-4.5', pricing: { prompt: '0.000003', completion: '0.000015' } },
      // $0.15 / $0.60 per M — gpt-4o-mini-style pricing.
      { id: 'openai/gpt-4o-mini', pricing: { prompt: '0.00000015', completion: '0.0000006' } },
    ]);
    expect(registered).toBe(2);

    const sonnetCost = estimateCost('anthropic/claude-sonnet-4.5', 1_000_000, 1_000_000);
    expect(sonnetCost).toBeCloseTo(3 + 15);

    const miniCost = estimateCost('openai/gpt-4o-mini', 1_000_000, 1_000_000);
    expect(miniCost).toBeCloseTo(0.15 + 0.6);
  });

  it('ingestOpenRouterCatalog skips entries with missing or malformed pricing', () => {
    const registered = ingestOpenRouterCatalog([
      { id: 'with-prompt-only', pricing: { prompt: '0.000001' } },
      { id: 'with-completion-only', pricing: { completion: '0.000001' } },
      { id: 'with-nothing' },
      { id: 'with-nan', pricing: { prompt: 'not-a-number', completion: '0.000001' } },
      { id: 'valid', pricing: { prompt: '0.000002', completion: '0.000008' } },
    ]);
    expect(registered).toBe(1);
    expect(estimateCost('valid', 1_000_000, 1_000_000)).toBeCloseTo(2 + 8);
    expect(estimateCost('with-prompt-only', 1_000_000, 1_000_000)).toBeNull();
  });

  it('clears the warned-unknown flag when a model gets registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Trip the warning once.
      estimateCost('anthropic/claude-sonnet-4.5', 100, 100);
      expect(warn).toHaveBeenCalledTimes(1);

      // Register after the warning fired — the flag should clear so a
      // subsequent unknown lookup of the SAME id would warn again if
      // pricing somehow disappeared.
      registerModelCost('anthropic/claude-sonnet-4.5', { input: 3, output: 15 });
      // Now remove it by resetting the runtime overlay and check that
      // estimateCost warns a second time (flag was cleared).
      _resetRuntimeModelCosts();
      estimateCost('anthropic/claude-sonnet-4.5', 100, 100);
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
