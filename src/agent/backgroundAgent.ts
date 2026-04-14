import { Disposable } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import { getConfig } from '../config/settings.js';
import { runAgentLoop } from './loop.js';
import type { AgentLogger } from './logger.js';
import type { MCPManager } from './mcpManager.js';
import { ToolRuntime } from './tools/runtime.js';

export interface BackgroundAgentRun {
  id: string;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  output: string;
  error?: string;
  toolCalls: number;
  abortController: AbortController;
}

/** Serializable subset of BackgroundAgentRun for the webview. */
export interface BackgroundAgentRunInfo {
  id: string;
  task: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  output: string;
  error?: string;
  toolCalls: number;
}

export interface BackgroundAgentCallbacks {
  onStatusChange: (run: BackgroundAgentRunInfo) => void;
  onOutput: (runId: string, chunk: string) => void;
  onComplete: (run: BackgroundAgentRunInfo) => void;
}

export function serializeRun(run: BackgroundAgentRun): BackgroundAgentRunInfo {
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    output: run.output,
    error: run.error,
    toolCalls: run.toolCalls,
  };
}

export class BackgroundAgentManager implements Disposable {
  private runs = new Map<string, BackgroundAgentRun>();
  private runCounter = 0;
  private callbacks: BackgroundAgentCallbacks;
  private logger: AgentLogger | undefined;
  private mcpManager: MCPManager | undefined;

  constructor(callbacks: BackgroundAgentCallbacks, logger?: AgentLogger, mcpManager?: MCPManager) {
    this.callbacks = callbacks;
    this.logger = logger;
    this.mcpManager = mcpManager;
  }

  start(task: string): string {
    const id = `bg-${++this.runCounter}`;
    const run: BackgroundAgentRun = {
      id,
      task,
      status: 'queued',
      startedAt: Date.now(),
      output: '',
      toolCalls: 0,
      abortController: new AbortController(),
    };
    this.runs.set(id, run);
    this.callbacks.onStatusChange(serializeRun(run));

    this.drainQueue();
    return id;
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.status === 'running' || run.status === 'queued') {
      run.abortController.abort();
      run.status = 'cancelled';
      run.completedAt = Date.now();
      this.callbacks.onStatusChange(serializeRun(run));
      this.drainQueue();
    }
    return true;
  }

  stopAll(): void {
    for (const run of this.runs.values()) {
      if (run.status === 'running' || run.status === 'queued') {
        run.abortController.abort();
        run.status = 'cancelled';
        run.completedAt = Date.now();
      }
    }
  }

  list(): BackgroundAgentRunInfo[] {
    return [...this.runs.values()].map(serializeRun);
  }

  get(runId: string): BackgroundAgentRunInfo | undefined {
    const run = this.runs.get(runId);
    return run ? serializeRun(run) : undefined;
  }

  private get runningCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') count++;
    }
    return count;
  }

  private drainQueue(): void {
    const maxConcurrent = getConfig().bgMaxConcurrent;
    for (const run of this.runs.values()) {
      if (this.runningCount >= maxConcurrent) break;
      if (run.status === 'queued') {
        run.status = 'running';
        this.callbacks.onStatusChange(serializeRun(run));
        this.executeRun(run).catch(() => {
          // Error already handled inside executeRun
        });
      }
    }
  }

  private async executeRun(run: BackgroundAgentRun): Promise<void> {
    const config = getConfig();
    const client = new SideCarClient(config.model, config.baseUrl, config.apiKey);
    client.updateSystemPrompt(
      'You are SideCar, an autonomous coding agent running as a background task. ' +
        'Complete the assigned task directly using tools. Do not ask clarifying questions. ' +
        'Be concise — focus on doing, not explaining.',
    );

    // Per-run ToolRuntime so parallel background agents don't share a
    // ShellSession. Without this, two agents that both `cd` somewhere
    // or set env vars would trample each other — the persistent shell
    // survives across tool calls within a run, which is exactly what
    // makes it unsafe to share across runs. Disposed in finally so the
    // child shell process is torn down even on failure/cancel.
    const toolRuntime = new ToolRuntime();

    const messages = [{ role: 'user' as const, content: run.task }];
    this.logger?.info(`[${run.id}] Starting: ${run.task}`);

    try {
      await runAgentLoop(
        client,
        messages,
        {
          onText: (text) => {
            run.output += text;
            this.callbacks.onOutput(run.id, text);
          },
          onToolCall: (name) => {
            run.toolCalls++;
            this.logger?.info(`[${run.id}] Tool: ${name}`);
          },
          onToolResult: (name, result, isError) => {
            this.logger?.debug(`[${run.id}] ${name}: ${isError ? 'error' : 'ok'} — ${result.slice(0, 100)}`);
          },
          onDone: () => {
            this.logger?.info(`[${run.id}] Completed`);
          },
        },
        run.abortController.signal,
        {
          logger: this.logger,
          mcpManager: this.mcpManager,
          approvalMode: 'autonomous',
          maxIterations: 15,
          toolRuntime,
        },
      );

      run.status = 'completed';
      run.completedAt = Date.now();
      this.callbacks.onComplete(serializeRun(run));
    } catch (err) {
      if (run.status === 'cancelled') {
        // Already handled by stop()
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      run.status = 'failed';
      run.error = msg;
      run.completedAt = Date.now();
      this.logger?.error(`[${run.id}] Failed: ${msg}`);
      this.callbacks.onComplete(serializeRun(run));
    } finally {
      toolRuntime.dispose();
      this.drainQueue();
    }
  }

  dispose(): void {
    this.stopAll();
    this.runs.clear();
  }
}
