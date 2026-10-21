// ---------------------------------------------------------------------------
// Token totals and cost for one SWE run (#261).
//
// A comparison with another agent on cost per resolved task needs SideCar's
// own numbers, and a cached run is mostly cache reads: Claude Code's Haiku
// canary run read 116M tokens from cache against 19K uncached. Pricing every
// token as plain input would overstate such a run about tenfold, so Anthropic
// models are priced with the spend tracker's cache-aware table.
// ---------------------------------------------------------------------------

import type { TokenUsage } from '../../src/ollama/types.js';
import { anthropicCostFor } from '../../src/ollama/spendTracker.js';
import { estimateCost } from '../../src/config/settings.js';
import type { RunTokenTotals } from './types.js';

export function emptyTotals(): RunTokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

/** Add one request's usage to the run totals. */
export function addUsage(totals: RunTokenTotals, usage: TokenUsage): void {
  totals.input += usage.inputTokens;
  totals.output += usage.outputTokens;
  totals.cacheCreation += usage.cacheCreationInputTokens;
  totals.cacheRead += usage.cacheReadInputTokens;
}

/** Share of all input served from cache, or null when no input was reported. */
export function cacheHitRate(totals: RunTokenTotals): number | null {
  const all = totals.input + totals.cacheCreation + totals.cacheRead;
  return all > 0 ? totals.cacheRead / all : null;
}

/**
 * USD cost of the run at list prices. Anthropic models use the cache-aware
 * table; other priced models (OpenAI, Gemini, ...) use the static table, whose
 * input price applies to all their input; anything else is null.
 */
export function runCostUsd(model: string, totals: RunTokenTotals): number | null {
  const anthropic = anthropicCostFor(model, {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheCreationInputTokens: totals.cacheCreation,
    cacheReadInputTokens: totals.cacheRead,
  });
  if (anthropic !== null) return anthropic;
  if (totals.input + totals.output === 0) return null;
  return estimateCost(model, totals.input + totals.cacheCreation + totals.cacheRead, totals.output);
}
