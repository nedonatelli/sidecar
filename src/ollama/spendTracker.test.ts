import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spendTracker, formatUsd, anthropicCostFor } from './spendTracker.js';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import * as fsMod from 'fs';

describe('SpendTracker.record', () => {
  beforeEach(() => spendTracker.reset());

  it('computes cost from the price table when no provider-reported cost is present', () => {
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // Haiku @ $1 per 1M input tokens → exactly $1 for a 1M-input call.
    expect(cost).toBeCloseTo(1.0, 4);
  });

  it('prices the Claude 5 models, cache reads included, by the longest matching prefix', () => {
    const oneMillionEach = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0 };
    expect(spendTracker.record('claude-opus-5-5', { ...oneMillionEach, cacheReadInputTokens: 0 })).toBeCloseTo(24, 4);
    // `claude-opus-5` must not take `claude-opus-5-5`'s price, or the reverse.
    expect(spendTracker.record('claude-opus-5', { ...oneMillionEach, cacheReadInputTokens: 0 })).toBeCloseTo(30, 4);
    expect(spendTracker.record('claude-sonnet-5-5', { ...oneMillionEach, cacheReadInputTokens: 0 })).toBeCloseTo(12, 4);
    expect(spendTracker.record('claude-haiku-5-5', { ...oneMillionEach, cacheReadInputTokens: 0 })).toBeCloseTo(0.6, 4);
    // Fable 5.1's published cache read is $0.25/M, a quarter of Fable 5's $1.
    const cacheOnly = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 };
    expect(spendTracker.record('claude-fable-5-1', cacheOnly)).toBeCloseTo(0.25, 4);
    expect(spendTracker.record('claude-fable-5', cacheOnly)).toBeCloseTo(1, 4);
  });

  it('prices Opus 4.6 at $5 / $25, not the old $15 / $75', () => {
    const cost = spendTracker.record('claude-opus-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeCloseTo(30, 4);
  });

  it('prefers provider-reported `costUsd` over the price-table computation', () => {
    // Table would say $1 (haiku × 1M input). Provider reports $0.50 — the
    // per-account discount path. Tracker must trust the reported value.
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0.5,
    });
    expect(cost).toBe(0.5);
    expect(spendTracker.snapshot().totalUsd).toBe(0.5);
  });

  it('records spend for models not in the price table when `costUsd` is provided', () => {
    // Before chunk 5, any model without a priceFor() entry returned 0
    // from record() and never showed up in the snapshot. With a
    // provider-reported cost, the tracker now bills it correctly.
    const cost = spendTracker.record('openrouter/mystery-model-xyz', {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0.0023,
    });
    expect(cost).toBe(0.0023);
    const snap = spendTracker.snapshot();
    expect(snap.totalUsd).toBe(0.0023);
    expect(snap.byModel[0].model).toBe('openrouter/mystery-model-xyz');
  });

  it('still returns 0 when costUsd is absent AND the model has no price entry', () => {
    // Local Ollama has no pricing and no provider-reported cost —
    // regression check that the zero-cost short-circuit still fires.
    const cost = spendTracker.record('ollama/qwen3-coder:30b', {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBe(0);
    expect(spendTracker.snapshot().totalUsd).toBe(0);
  });

  it('treats a non-finite costUsd (NaN, Infinity) as "not reported" and falls back to the table', () => {
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: NaN,
    });
    expect(cost).toBeCloseTo(1.0, 4); // fell back to the price table
  });

  it('accumulates costUsd across multiple records for the same model', () => {
    spendTracker.record('mystery-model', {
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0.01,
    });
    spendTracker.record('mystery-model', {
      inputTokens: 200,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      costUsd: 0.02,
    });
    const snap = spendTracker.snapshot();
    expect(snap.totalUsd).toBeCloseTo(0.03, 4);
    expect(snap.byModel[0].requests).toBe(2);
  });
});

describe('cache token billing (input_tokens EXCLUDES cache tokens) (#261)', () => {
  beforeEach(() => spendTracker.reset());

  // Anthropic's prompt-caching docs: input_tokens counts only the tokens after
  // the last cache breakpoint, and
  //   total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
  // The three are priced separately and summed. These tests used to encode the
  // opposite (cache tokens as a subset of input_tokens), which priced a cached
  // request's uncached input at $0.
  // Haiku 4.5: input $1/M, output $5/M, cache write $1.25/M, cache read $0.10/M.

  it('prices uncached input, cache writes and cache reads separately and sums them', () => {
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 10_000, // after the last breakpoint
      outputTokens: 0,
      cacheCreationInputTokens: 10_000,
      cacheReadInputTokens: 80_000,
    });
    // 10K x $1 + 10K x $1.25 + 80K x $0.10 = $0.01 + $0.0125 + $0.008
    expect(cost).toBeCloseTo(0.0305, 6);
  });

  it('bills the uncached input of a cached request (the old subtraction priced it at $0)', () => {
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 2_000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50_000,
    });
    // 2K x $1 + 500 x $5 + 50K x $0.10 = $0.002 + $0.0025 + $0.005
    expect(cost).toBeCloseTo(0.0095, 6);
  });

  it('a request served entirely from cache costs only the cache reads', () => {
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50_000,
    });
    expect(cost).toBeCloseTo(0.005, 6);
  });

  it('a cache write is priced at 1.25x input', () => {
    const cost = spendTracker.record('claude-haiku-4-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 50_000,
      cacheReadInputTokens: 0,
    });
    expect(cost).toBeCloseTo(0.0625, 6);
  });

  it("prices Sonnet 5.5 cache reads at Anthropic's $0.10/M (0.05x input), not Sonnet 5's $0.20", () => {
    const cacheOnly = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000 };
    expect(spendTracker.record('claude-sonnet-5-5', cacheOnly)).toBeCloseTo(0.1, 6);
    expect(spendTracker.record('claude-sonnet-5', cacheOnly)).toBeCloseTo(0.2, 6);
    expect(spendTracker.record('claude-opus-5-5', cacheOnly)).toBeCloseTo(0.2, 6);
  });

  it('anthropicCostFor is the same price, and null for a model with no Anthropic price', () => {
    const usage = {
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 1_000,
      cacheReadInputTokens: 1_000,
    };
    expect(anthropicCostFor('claude-haiku-4-5', usage)).toBeCloseTo((1 + 5 + 1.25 + 0.1) / 1_000, 9);
    expect(anthropicCostFor('gemma4:e4b', usage)).toBeNull();
  });
});

describe('SpendTracker JSONL append', () => {
  beforeEach(() => spendTracker.reset());

  it('calls appendJsonl when sidecarDir is ready and cost > 0', async () => {
    const mockDir = {
      isReady: () => true,
      appendJsonl: vi.fn().mockResolvedValue(undefined),
    };
    spendTracker.init(mockDir as never);
    spendTracker.record('claude-haiku-4-5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockDir.appendJsonl).toHaveBeenCalled();
    spendTracker.init(null as never);
  });

  it('does not call appendJsonl when cost is 0', async () => {
    const mockDir = {
      isReady: () => true,
      appendJsonl: vi.fn().mockResolvedValue(undefined),
    };
    spendTracker.init(mockDir as never);
    spendTracker.record('unknown-local-model', {
      inputTokens: 1000,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockDir.appendJsonl).not.toHaveBeenCalled();
    spendTracker.init(null as never);
  });
});

describe('SpendTracker.restoreFromDisk', () => {
  const mockSidecarDir = {
    isReady: () => true,
    getPath: (name: string) => `/tmp/.sidecar/${name}`,
  };

  beforeEach(() => {
    spendTracker.reset();
    vi.clearAllMocks();
    vi.mocked(fsMod.promises.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('returns early when sidecarDir is not set', async () => {
    await expect(spendTracker.restoreFromDisk()).resolves.toBeUndefined();
  });

  it('returns early when sidecarDir is not ready', async () => {
    spendTracker.init({ isReady: () => false, getPath: () => '' } as never);
    await expect(spendTracker.restoreFromDisk()).resolves.toBeUndefined();
    spendTracker.init(null as never);
  });

  it('does nothing when spend.jsonl is absent', async () => {
    spendTracker.init(mockSidecarDir as never);
    await spendTracker.restoreFromDisk();
    expect(spendTracker.snapshot().totalUsd).toBe(0);
    spendTracker.init(null as never);
  });

  it('replays today entries from spend.jsonl into the in-memory map', async () => {
    spendTracker.init(mockSidecarDir as never);
    const todayEntry = JSON.stringify({
      timestamp: Date.now(),
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: 0.42,
    });
    vi.mocked(fsMod.promises.readFile).mockResolvedValueOnce(todayEntry as never);

    await spendTracker.restoreFromDisk();
    const snap = spendTracker.snapshot();
    expect(snap.totalUsd).toBeCloseTo(0.42);
    expect(snap.byModel[0].model).toBe('claude-sonnet-4-6');
    spendTracker.init(null as never);
  });

  it('skips entries from previous days', async () => {
    spendTracker.init(mockSidecarDir as never);
    const oldEntry = JSON.stringify({
      timestamp: Date.now() - 2 * 24 * 3600 * 1000,
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: 9.99,
    });
    vi.mocked(fsMod.promises.readFile).mockResolvedValueOnce(oldEntry as never);

    await spendTracker.restoreFromDisk();
    expect(spendTracker.snapshot().totalUsd).toBe(0);
    spendTracker.init(null as never);
  });

  it('accumulates multiple entries for the same model', async () => {
    spendTracker.init(mockSidecarDir as never);
    const entry = (cost: number) =>
      JSON.stringify({
        timestamp: Date.now(),
        model: 'claude-haiku-4-5',
        usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: cost,
      });
    vi.mocked(fsMod.promises.readFile).mockResolvedValueOnce(`${entry(0.1)}\n${entry(0.2)}` as never);

    await spendTracker.restoreFromDisk();
    expect(spendTracker.snapshot().totalUsd).toBeCloseTo(0.3);
    spendTracker.init(null as never);
  });

  it('skips malformed lines gracefully', async () => {
    spendTracker.init(mockSidecarDir as never);
    const goodEntry = JSON.stringify({
      timestamp: Date.now(),
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      costUsd: 0.05,
    });
    vi.mocked(fsMod.promises.readFile).mockResolvedValueOnce(`bad json line\n${goodEntry}` as never);

    await spendTracker.restoreFromDisk();
    expect(spendTracker.snapshot().totalUsd).toBeCloseTo(0.05);
    spendTracker.init(null as never);
  });
});

describe('SpendTracker.dispose', () => {
  it('disposes without error', () => {
    expect(() => spendTracker.dispose()).not.toThrow();
  });
});

describe('formatUsd', () => {
  it('uses 4-decimal precision for sub-cent amounts', () => {
    expect(formatUsd(0.0023)).toBe('$0.0023');
  });

  it('uses 3-decimal precision for sub-dollar amounts', () => {
    expect(formatUsd(0.123)).toBe('$0.123');
  });

  it('uses 2-decimal precision for >= $1', () => {
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});
