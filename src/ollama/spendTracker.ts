import { EventEmitter } from 'vscode';
import { logger } from '../system/logger.js';
import type { TokenUsage } from './types.js';
import type { SidecarDir } from '../config/sidecarDir.js';

const SPEND_LOG = 'logs/spend.jsonl';

// Per-million-token USD prices for Anthropic Claude models.
// Keys are matched by `modelId.startsWith(key)`; pick the longest match.
// Update when Anthropic publishes new SKUs. Prices are list, not enterprise.
// Claude 5 and Opus 4.6-4.8 from Anthropic's model table (2026-10-06). Cache
// writes are the standard 1.25x of input. Cache reads are the published figure
// where there is one (Fable 5.1 $0.25, Opus 5.5 $0.20 and Sonnet 5.5 $0.10 --
// both 0.05x of input -- and Fable 5 $1) and the standard 0.1x otherwise.
// Sonnet 5.5's was $0.20, Sonnet 5's figure; Anthropic's pricing table says
// $0.10 (checked 2026-10-21). Haiku 5.5 is the price up to 100K prompt
// tokens; above that it is $0.50 / $2.50, which this table doesn't model.
const ANTHROPIC_PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
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

/**
 * USD cost of one request's usage at Anthropic list prices, or `null` for a
 * model not in the table.
 *
 * Anthropic's `input_tokens` EXCLUDES the cache tokens: it counts only the
 * tokens after the last cache breakpoint, and total input is
 * `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
 * (prompt-caching docs). So the three are priced separately and summed.
 * This used to subtract the cache tokens from `input_tokens`, on the belief
 * they were included: in any cached request they are larger, so uncached
 * input clamped to 0 and was never billed (#261).
 *
 * Cache writes are priced at the 5-minute rate, the only TTL SideCar sets.
 */
export function anthropicCostFor(model: string, usage: TokenUsage): number | null {
  const price = priceFor(model);
  if (!price) return null;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheCreationInputTokens * price.cacheWrite +
      usage.cacheReadInputTokens * price.cacheRead) /
    1_000_000
  );
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
  private sidecarDir: SidecarDir | null = null;

  /** Wire up disk persistence. Call once from extension activation after SidecarDir is ready. */
  init(dir: SidecarDir): void {
    this.sidecarDir = dir;
  }

  /** Replay spend.jsonl entries into the in-memory map so the session total
   *  survives VS Code restarts. Only entries from the current calendar day
   *  are replayed — older history is available in the file but kept out of
   *  the live session total to avoid confusing the status bar. */
  async restoreFromDisk(): Promise<void> {
    if (!this.sidecarDir?.isReady()) return;
    try {
      const { promises: fsp } = await import('fs');
      const filePath = this.sidecarDir.getPath(SPEND_LOG);
      let raw: string;
      try {
        raw = await fsp.readFile(filePath, 'utf-8');
      } catch {
        return; // file absent — nothing to restore
      }
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { timestamp: number; model: string; usage: TokenUsage; costUsd: number };
          if (entry.timestamp < startOfDay.getTime()) continue;
          const existing = this.byModel.get(entry.model);
          if (existing) {
            existing.usage.inputTokens += entry.usage.inputTokens;
            existing.usage.outputTokens += entry.usage.outputTokens;
            existing.usage.cacheCreationInputTokens += entry.usage.cacheCreationInputTokens;
            existing.usage.cacheReadInputTokens += entry.usage.cacheReadInputTokens;
            existing.costUsd += entry.costUsd;
            existing.requests += 1;
          } else {
            this.byModel.set(entry.model, {
              model: entry.model,
              usage: { ...entry.usage },
              costUsd: entry.costUsd,
              requests: 1,
            });
          }
        } catch {
          /* malformed line — skip */
        }
      }
    } catch (err) {
      logger.warn('[SideCar] Failed to restore spend from disk:', err);
    }
  }

  /**
   * Record a dispatch's usage + cost. Returns the computed cost in USD
   * (or `0` when the provider isn't priced — local Ollama, OpenRouter
   * without catalog ingest, etc.) so callers can forward the number to
   * ModelRouter.recordSpend for budget-aware routing .
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
      const priced = anthropicCostFor(model, usage);
      if (priced === null) return 0; // Unknown (non-Anthropic) model — nothing to bill.
      cost = priced;
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

    // Fire-and-forget JSONL append — errors are non-fatal
    if (this.sidecarDir?.isReady() && cost > 0) {
      this.sidecarDir
        .appendJsonl(SPEND_LOG, {
          timestamp: Date.now(),
          model,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
          },
          costUsd: cost,
        })
        .catch((err: unknown) => logger.warn('[SideCar] spend.jsonl append failed:', err));
    }

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
