import { Disposable } from 'vscode';
import type { ScheduledTask } from '../config/settings.js';
import { SideCarClient } from '../ollama/client.js';
import { getConfig } from '../config/settings.js';
import { runAgentLoop } from './loop.js';
import { runAgentLoopInSandbox } from './shadow/sandbox.js';
import type { AgentLogger } from './logger.js';
import type { MCPManager } from './mcpManager.js';
import { checkDocumentGate } from './documentGate.js';
import { FileLock } from './lockPrimitives.js';

// Module-level FileLock singleton for coordinating scheduled task execution
const fileLock = new FileLock();

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

    // Acquire lock for this task (prevents concurrent execution on same files)
    const release = await fileLock.acquire(task.name);

    try {
      const config = getConfig();
      const client = new SideCarClient(config.model, config.baseUrl, config.apiKey);
      const messages = [{ role: 'user' as const, content: task.prompt }];
      const abortController = new AbortController();

      // Check if target files are dirty (open and unsaved in editor)
      const gateCheck = checkDocumentGate(task.targetPaths || []);

      const callbacks = {
        onText: (text: string) => {
          this.logger?.debug(`[${task.name}] ${text}`);
        },
        onToolCall: (name: string) => {
          this.logger?.info(`[${task.name}] Tool call: ${name}`);
        },
        onToolResult: (name: string, result: string, isError: boolean) => {
          this.logger?.info(`[${task.name}] ${name}: ${isError ? 'error' : 'ok'} — ${result.slice(0, 100)}`);
        },
        onDone: () => {
          this.logger?.info(`[${task.name}] Completed`);
        },
      };

      const options = {
        logger: this.logger,
        mcpManager: this.mcpManager,
        approvalMode: 'autonomous' as const,
        maxIterations: 10,
      };

      // If target files are dirty, route through Shadow Workspace for safety
      if (gateCheck.dirty) {
        this.logger?.warn(
          `[${task.name}] Target files are dirty: ${gateCheck.dirtyFiles.join(', ')}. ` +
            `Running in Shadow Workspace for safety.`,
        );
        await runAgentLoopInSandbox(client, messages, callbacks, abortController.signal, options, {
          forceShadow: true,
          deferPrompt: true,
        });
      } else {
        await runAgentLoop(client, messages, callbacks, abortController.signal, options);
      }
    } catch (err) {
      this.logger?.error(`[${task.name}] Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      release();
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
