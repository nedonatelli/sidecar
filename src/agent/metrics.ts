import type { Memento } from 'vscode';
import { CHARS_PER_TOKEN } from '../config/constants.js';

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
}

const STORAGE_KEY = 'sidecar.metrics';

export class MetricsCollector {
  private currentRun: Partial<AgentRunMetrics> | null = null;
  private toolStartTime = 0;

  constructor(private workspaceState: Memento) {}

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
      this.currentRun.totalTokensEstimate =
        (this.currentRun.totalTokensEstimate || 0) + Math.ceil(chars / CHARS_PER_TOKEN);
    }
  }

  recordError(err: string): void {
    this.currentRun?.errors?.push(err);
  }

  endRun(): void {
    if (!this.currentRun) return;
    this.currentRun.durationMs = Date.now() - (this.currentRun.timestamp || 0);
    const history = this.getHistory();
    history.push(this.currentRun as AgentRunMetrics);
    if (history.length > 100) history.splice(0, history.length - 100);
    this.workspaceState.update(STORAGE_KEY, history);
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
}
