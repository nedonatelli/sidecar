import { Disposable } from 'vscode';
import type { ScheduledTask } from '../config/settings.js';
import { SideCarClient } from '../ollama/client.js';
import { getModel, getBaseUrl, getApiKey } from '../config/settings.js';
import { runAgentLoop } from './loop.js';
import type { AgentLogger } from './logger.js';
import type { MCPManager } from './mcpManager.js';

export class Scheduler implements Disposable {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private logger: AgentLogger | undefined;
  private mcpManager: MCPManager | undefined;

  constructor(logger?: AgentLogger, mcpManager?: MCPManager) {
    this.logger = logger;
    this.mcpManager = mcpManager;
  }

  start(tasks: ScheduledTask[]): void {
    this.stop();

    for (const task of tasks) {
      if (!task.enabled) continue;
      if (task.intervalMinutes < 1) continue;

      const intervalMs = task.intervalMinutes * 60 * 1000;
      this.logger?.info(`Scheduled task "${task.name}" every ${task.intervalMinutes}m`);

      const timer = setInterval(() => {
        this.runTask(task);
      }, intervalMs);

      this.timers.set(task.name, timer);
    }
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    this.logger?.info(`Running scheduled task: ${task.name}`);

    const client = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
    const messages = [{ role: 'user' as const, content: task.prompt }];
    const abortController = new AbortController();

    try {
      await runAgentLoop(
        client,
        messages,
        {
          onText: (text) => {
            this.logger?.debug(`[${task.name}] ${text}`);
          },
          onToolCall: (name) => {
            this.logger?.info(`[${task.name}] Tool call: ${name}`);
          },
          onToolResult: (name, result, isError) => {
            this.logger?.info(`[${task.name}] ${name}: ${isError ? 'error' : 'ok'} — ${result.slice(0, 100)}`);
          },
          onDone: () => {
            this.logger?.info(`[${task.name}] Completed`);
          },
        },
        abortController.signal,
        {
          logger: this.logger,
          mcpManager: this.mcpManager,
          approvalMode: 'autonomous', // Scheduled tasks run autonomously
          maxIterations: 10,
        }
      );
    } catch (err) {
      this.logger?.error(`[${task.name}] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  dispose(): void {
    this.stop();
  }
}
