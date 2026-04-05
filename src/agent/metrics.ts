import type { Memento } from 'vscode';

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
    };
  }

  recordIteration(): void {
    if (this.currentRun) this.currentRun.iterations = (this.currentRun.iterations || 0) + 1;
  }

  recordToolStart(): void {
    this.toolStartTime = Date.now();
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
      this.currentRun.totalTokensEstimate = (this.currentRun.totalTokensEstimate || 0) + Math.ceil(chars / 4);
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

  getHistory(): AgentRunMetrics[] {
    return this.workspaceState.get<AgentRunMetrics[]>(STORAGE_KEY, []);
  }
}
