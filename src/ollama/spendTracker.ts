import { EventEmitter } from 'vscode';
import type { TokenUsage } from './types.js';

// Per-million-token USD prices for Anthropic Claude models.
// Keys are matched by `modelId.startsWith(key)`; pick the longest match.
// Update when Anthropic publishes new SKUs. Prices are list, not enterprise.
const ANTHROPIC_PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-6': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4-5': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  'claude-3-opus': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
};

function priceFor(model: string): { input: number; output: number; cacheWrite: number; cacheRead: number } | null {
  let best: string | null = null;
  for (const key of Object.keys(ANTHROPIC_PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best ? ANTHROPIC_PRICES[best] : null;
}

export interface ModelSpend {
  model: string;
  usage: TokenUsage;
  costUsd: number;
  requests: number;
}

export interface SpendSnapshot {
  totalUsd: number;
  totalRequests: number;
  byModel: ModelSpend[];
  sessionStart: number;
}

class SpendTracker {
  private byModel = new Map<string, ModelSpend>();
  private sessionStart = Date.now();
  private _onDidChange = new EventEmitter<SpendSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  /**
   * Record a dispatch's usage + cost. Returns the computed cost in USD
   * (or `0` when the provider isn't priced — local Ollama, OpenRouter
   * without catalog ingest, etc.) so callers can forward the number to
   * ModelRouter.recordSpend for budget-aware routing (v0.64 phase 4c).
   *
   * When the caller passes a `usage.costUsd` (OpenRouter ships this as
   * `usage.cost` on every response; v0.64 chunk 5), the provider-reported
   * value wins — it accounts for per-account discounts, pricing tiers,
   * and cache bonuses the static price table would miss.
   */
  record(model: string, usage: TokenUsage): number {
    let cost: number;
    if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
      // Provider-reported — trust it verbatim. No table lookup required;
      // works for any model the upstream API bills, including ones we'd
      // otherwise call "unknown" and skip.
      cost = usage.costUsd;
    } else {
      const price = priceFor(model);
      if (!price) return 0; // Unknown (non-Anthropic) model — nothing to bill.

      cost =
        (usage.inputTokens * price.input) / 1_000_000 +
        (usage.outputTokens * price.output) / 1_000_000 +
        (usage.cacheCreationInputTokens * price.cacheWrite) / 1_000_000 +
        (usage.cacheReadInputTokens * price.cacheRead) / 1_000_000;
    }

    const existing = this.byModel.get(model);
    if (existing) {
      existing.usage.inputTokens += usage.inputTokens;
      existing.usage.outputTokens += usage.outputTokens;
      existing.usage.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      existing.usage.cacheReadInputTokens += usage.cacheReadInputTokens;
      existing.costUsd += cost;
      existing.requests += 1;
    } else {
      this.byModel.set(model, {
        model,
        usage: { ...usage },
        costUsd: cost,
        requests: 1,
      });
    }

    this._onDidChange.fire(this.snapshot());
    return cost;
  }

  snapshot(): SpendSnapshot {
    let totalUsd = 0;
    let totalRequests = 0;
    const byModel: ModelSpend[] = [];
    for (const entry of this.byModel.values()) {
      totalUsd += entry.costUsd;
      totalRequests += entry.requests;
      byModel.push(entry);
    }
    byModel.sort((a, b) => b.costUsd - a.costUsd);
    return { totalUsd, totalRequests, byModel, sessionStart: this.sessionStart };
  }

  reset(): void {
    this.byModel.clear();
    this.sessionStart = Date.now();
    this._onDidChange.fire(this.snapshot());
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export const spendTracker = new SpendTracker();

export function formatUsd(amount: number): string {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}
