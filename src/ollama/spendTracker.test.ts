import { describe, it, expect, beforeEach } from 'vitest';
import { spendTracker, formatUsd } from './spendTracker.js';

describe('SpendTracker.record (v0.64 chunk 5 — provider `usage.cost` pass-through)', () => {
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
