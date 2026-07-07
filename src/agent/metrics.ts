import type { Memento } from 'vscode';
import { logger } from '../system/logger.js';
import { charsToTokens } from '../config/tokenEstimation.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { FailureBucket } from './failureTaxonomy.js';

const METRICS_LOG = 'logs/metrics.jsonl';

export interface ToolCallMetric {
  name: string;
  durationMs: number;
  isError: boolean;
}

export interface AgentRunMetrics {
  timestamp: number;
  iterations: number;
  toolCalls: ToolCallMetric[];
  totalTokensEstimate: number;
  durationMs: number;
  errors: string[];
  /** Estimated cost in USD for this run (null for local models). */
  costUsd: number | null;
  // --- F2 diagnostic signals (scaffolding roadmap Phase 0) ---
  /** Tool calls whose first-attempt arguments failed to parse (pre-repair). */
  malformedToolCalls?: number;
  /** Of the malformed calls, how many constrained-decoding repair recovered. */
  repairedToolCalls?: number;
  /** F1 failure bucket, or null/undefined when the run succeeded. */
  failureBucket?: FailureBucket | null;
}

const STORAGE_KEY = 'sidecar.metrics';

export class MetricsCollector {
  private currentRun: Partial<AgentRunMetrics> | null = null;
  private toolStartTime = 0;
  private sidecarDir: SidecarDir | null = null;

  constructor(private workspaceState: Memento) {}

  /** Wire up JSONL persistence. Call once from extension activation. */
  init(dir: SidecarDir): void {
    this.sidecarDir = dir;
  }

  startRun(): void {
    this.currentRun = {
      timestamp: Date.now(),
      toolCalls: [],
      errors: [],
      iterations: 0,
      totalTokensEstimate: 0,
      costUsd: null,
    };
  }

  recordIteration(): void {
    if (this.currentRun) this.currentRun.iterations = (this.currentRun.iterations || 0) + 1;
  }

  recordToolStart(): void {
    this.toolStartTime = Date.now();
  }

  /** Get elapsed time since the last recordToolStart() call. */
  getToolDuration(): number {
    return Date.now() - this.toolStartTime;
  }

  recordToolEnd(name: string, isError: boolean): void {
    this.currentRun?.toolCalls?.push({
      name,
      durationMs: Date.now() - this.toolStartTime,
      isError,
    });
  }

  recordTokens(chars: number): void {
    if (this.currentRun) {
      this.currentRun.totalTokensEstimate = (this.currentRun.totalTokensEstimate || 0) + charsToTokens(chars);
    }
  }

  /**
   * Latest-wins token estimate for the run. Local backends (Ollama) emit no
   * per-turn `usage` event, so the loop's running whole-conversation estimate
   * (`onIterationStart.estimatedTokens`) is the only token signal available.
   * It grows monotonically as context accumulates, so the last value is the
   * run's peak context size — the honest per-task token number for local models.
   */
  setTokenEstimate(tokens: number): void {
    if (this.currentRun && tokens > (this.currentRun.totalTokensEstimate || 0)) {
      this.currentRun.totalTokensEstimate = tokens;
    }
  }

  recordError(err: string): void {
    this.currentRun?.errors?.push(err);
  }

  /** F2 — record a turn's malformed tool calls and how many repair recovered. */
  recordMalformedToolCalls(malformed: number, repaired: number): void {
    if (!this.currentRun || malformed <= 0) return;
    this.currentRun.malformedToolCalls = (this.currentRun.malformedToolCalls ?? 0) + malformed;
    this.currentRun.repairedToolCalls = (this.currentRun.repairedToolCalls ?? 0) + repaired;
  }

  /** F1 — record the run's outcome: a failure bucket, or null for success. */
  recordOutcome(bucket: FailureBucket | null): void {
    if (this.currentRun) this.currentRun.failureBucket = bucket;
  }

  endRun(): void {
    if (!this.currentRun) return;
    this.currentRun.durationMs = Date.now() - (this.currentRun.timestamp || 0);
    const run = this.currentRun as AgentRunMetrics;

    // Keep the last 100 runs in workspaceState for fast in-session access.
    const history = this.getHistory();
    history.push(run);
    if (history.length > 100) history.splice(0, history.length - 100);
    this.workspaceState.update(STORAGE_KEY, history);

    // Append to rolling JSONL for long-term history (no cap).
    if (this.sidecarDir?.isReady()) {
      this.sidecarDir
        .appendJsonl(METRICS_LOG, run)
        .catch((err: unknown) => logger.warn('[SideCar] metrics.jsonl append failed:', err));
    }

    this.currentRun = null;
  }

  recordCost(costUsd: number | null): void {
    if (this.currentRun) {
      this.currentRun.costUsd = costUsd;
    }
  }

  getHistory(): AgentRunMetrics[] {
    return this.workspaceState.get<AgentRunMetrics[]>(STORAGE_KEY, []);
  }

  /**
   * Sum estimated cost (USD) for runs within a time window.
   * Runs without cost data (local models) are excluded.
   */
  getSpendSince(sinceMs: number): number {
    const history = this.getHistory();
    let total = 0;
    for (const run of history) {
      if (run.timestamp >= sinceMs && run.costUsd !== null && run.costUsd !== undefined) {
        total += run.costUsd;
      }
    }
    return total;
  }

  /** Cost spent in the current calendar day (local midnight). */
  getDailySpend(): number {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return this.getSpendSince(startOfDay);
  }

  /** Cost spent in the current calendar week (Monday midnight). */
  getWeeklySpend(): number {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 1=Mon, ...
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime();
    return this.getSpendSince(startOfWeek);
  }

  /**
   * Combined daily + weekly spend in a single `getHistory()` read. The
   * budget check in `handleUserMessage` needs both numbers at once;
   * calling `getDailySpend()` and `getWeeklySpend()` separately
   * deserializes the persisted history twice. This helper computes both
   * sums in one pass.
   */
  getSpendBreakdown(): { daily: number; weekly: number } {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const daysSinceMonday = now.getDay() === 0 ? 6 : now.getDay() - 1;
    const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime();
    const history = this.getHistory();
    let daily = 0;
    let weekly = 0;
    for (const run of history) {
      if (run.costUsd === null || run.costUsd === undefined) continue;
      if (run.timestamp >= startOfWeek) weekly += run.costUsd;
      if (run.timestamp >= startOfDay) daily += run.costUsd;
    }
    return { daily, weekly };
  }

  /**
   * Estimated token count for the run currently in progress (if any).
   * Returns 0 when no run is active. Exposed as a public getter so
   * callers don't need to reach into `this.currentRun` via
   * bracket-notation private access, which was flagged by the audit.
   */
  getCurrentRunTokens(): number {
    return this.currentRun?.totalTokensEstimate ?? 0;
  }

  /**
   * Aggregate metrics from the JSONL log for the last `days` calendar days.
   * Falls back to workspaceState history when the log file is absent.
   * Returns null when sidecarDir is not ready.
   */
  async getMetricsSince(days: number): Promise<{
    runs: number;
    iterations: number;
    toolCallCount: number;
    errorCount: number;
    totalCostUsd: number;
    byTool: Record<string, { count: number; errors: number }>;
    // --- F2 diagnostics ---
    /** Fraction of tool calls whose first-attempt args parsed (the Phase 1 lever). */
    schemaValidityRate: number;
    /** Fraction of malformed calls that constrained-decoding repair recovered. */
    repairRate: number;
    /** Fraction of tool calls that executed without an error result. */
    executableCallRate: number;
    latencyP50Ms: number;
    latencyP95Ms: number;
    /** Cost (USD) per successful run; 0 when no priced successful runs. */
    costPerSuccessfulRun: number;
    /** Distribution of F1 failure buckets across failed runs. */
    failureBuckets: Record<string, number>;
  } | null> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let runs: AgentRunMetrics[] = [];

    if (this.sidecarDir?.isReady()) {
      try {
        const { promises: fsp } = await import('fs');
        const raw = await fsp.readFile(this.sidecarDir.getPath(METRICS_LOG), 'utf-8').catch(() => '');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as AgentRunMetrics;
            if (entry.timestamp >= cutoff) runs.push(entry);
          } catch {
            /* malformed — skip */
          }
        }
      } catch {
        /* log absent — fall through */
      }
    }

    // Fall back to workspaceState when log is empty or unavailable
    if (runs.length === 0) {
      runs = this.getHistory().filter((r) => r.timestamp >= cutoff);
    }

    const byTool: Record<string, { count: number; errors: number }> = {};
    const failureBuckets: Record<string, number> = {};
    const latencies: number[] = [];
    let iterations = 0;
    let toolCallCount = 0;
    let toolErrorCount = 0;
    let errorCount = 0;
    let totalCostUsd = 0;
    let malformedTotal = 0;
    let repairedTotal = 0;
    let successfulRuns = 0;
    let successfulCost = 0;
    for (const run of runs) {
      iterations += run.iterations;
      errorCount += run.errors?.length ?? 0;
      if (run.costUsd) totalCostUsd += run.costUsd;
      malformedTotal += run.malformedToolCalls ?? 0;
      repairedTotal += run.repairedToolCalls ?? 0;
      const failed = run.failureBucket !== null && run.failureBucket !== undefined;
      if (failed) failureBuckets[run.failureBucket as string] = (failureBuckets[run.failureBucket as string] ?? 0) + 1;
      else {
        successfulRuns++;
        if (run.costUsd) successfulCost += run.costUsd;
      }
      for (const tc of run.toolCalls ?? []) {
        toolCallCount++;
        latencies.push(tc.durationMs);
        const t = (byTool[tc.name] ??= { count: 0, errors: 0 });
        t.count++;
        if (tc.isError) {
          t.errors++;
          toolErrorCount++;
        }
      }
    }

    return {
      runs: runs.length,
      iterations,
      toolCallCount,
      errorCount,
      totalCostUsd,
      byTool,
      schemaValidityRate: toolCallCount > 0 ? (toolCallCount - malformedTotal) / toolCallCount : 1,
      repairRate: malformedTotal > 0 ? repairedTotal / malformedTotal : 1,
      executableCallRate: toolCallCount > 0 ? (toolCallCount - toolErrorCount) / toolCallCount : 1,
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      costPerSuccessfulRun: successfulRuns > 0 ? successfulCost / successfulRuns : 0,
      failureBuckets,
    };
  }
}

/** Linear-interpolation percentile over an unsorted sample; 0 when empty. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
