import { describe, it, expect } from 'vitest';
import { emptyTotals, addUsage, cacheHitRate, runCostUsd } from './runCost.js';

// #261: per-run token totals and a cache-aware cost for SWE predictions.

const use = (input: number, output: number, cacheCreation = 0, cacheRead = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheCreationInputTokens: cacheCreation,
  cacheReadInputTokens: cacheRead,
});

describe('run token totals and cost (#261)', () => {
  it('sums every request, keeping the four kinds separate', () => {
    const t = emptyTotals();
    addUsage(t, use(100, 10, 1_000, 0));
    addUsage(t, use(50, 20, 0, 1_000));
    expect(t).toEqual({ input: 150, output: 30, cacheCreation: 1_000, cacheRead: 1_000 });
  });

  it('cache hit rate is cache reads over all input, null with no input', () => {
    // Claude Code's Haiku canary run: 116M read, 2.6M written, 19K uncached -> 97.8%.
    const cc = { input: 19_000, output: 0, cacheCreation: 2_600_000, cacheRead: 116_000_000 };
    expect(cacheHitRate(cc)).toBeCloseTo(0.978, 3);
    expect(cacheHitRate(emptyTotals())).toBeNull();
  });

  it('prices an Anthropic run with cache rates, not as plain input', () => {
    const t = { input: 19_000, output: 500_000, cacheCreation: 2_600_000, cacheRead: 116_000_000 };
    // Haiku 4.5: 0.019 x $1 + 0.5 x $5 + 2.6 x $1.25 + 116 x $0.10 = 0.019 + 2.5 + 3.25 + 11.6
    expect(runCostUsd('claude-haiku-4-5', t)).toBeCloseTo(17.369, 3);
    // Summing every input token at the plain input price would say about $121.
    const plain = (t.input + t.cacheCreation + t.cacheRead) * 1e-6 * 1 + t.output * 5e-6;
    expect(plain).toBeGreaterThan(6 * runCostUsd('claude-haiku-4-5', t)!);
  });

  it('prices a non-Anthropic model from the static table, and an unpriced one as null', () => {
    const t = { input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0 };
    expect(runCostUsd('gpt-6-luna', t)).toBeCloseTo(0.6, 6);
    expect(runCostUsd('gemma4:e4b', t)).toBeNull();
    expect(runCostUsd('claude-haiku-4-5', emptyTotals())).toBe(0);
  });
});
