import { workspace, Disposable } from 'vscode';
import * as path from 'path';
import type { ScheduledTask } from '../config/settings.js';
import { SideCarClient } from '../ollama/client.js';
import { getConfig } from '../config/settings.js';
import { runAgentLoop } from './loop.js';
import { runAgentLoopInSandbox } from './shadow/sandbox.js';
import type { AgentLogger } from './logger.js';
import type { MCPManager } from './mcpManager.js';
import { checkDocumentGate } from './documentGate.js';
import { FileLock } from './lockPrimitives.js';
import { parseCron, cronMatches } from './cronParser.js';
import { matchGlob } from '../util/glob.js';

// ---------------------------------------------------------------------------
// Scheduler — runs ScheduledTask entries on three trigger types:
//
//   1. interval  — fires every `intervalMinutes` minutes (legacy)
//   2. cron      — fires when the wall clock matches a 5-field cron expression;
//                  checked once per minute by a shared setInterval tick
//   3. onSave    — fires when a saved file matches any glob in the `onSave` array
//
// For time-based tasks (interval + cron) that target dirty files, the task
// is automatically routed through a Shadow Workspace so the main tree stays
// clean until the user reviews.
// ---------------------------------------------------------------------------

const fileLock = new FileLock();

export interface TaskRunRecord {
  taskName: string;
  startedAt: number;
  finishedAt: number;
  success: boolean;
  errorMessage?: string;
}

export class Scheduler implements Disposable {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private parsedCrons: Map<string, ReturnType<typeof parseCron>> = new Map();
  private saveSub: Disposable | null = null;
  private tasks: ScheduledTask[] = [];
  private logger: AgentLogger | undefined;
  private mcpManager: MCPManager | undefined;
  private runHistory: TaskRunRecord[] = [];

  constructor(logger?: AgentLogger, mcpManager?: MCPManager) {
    this.logger = logger;
    this.mcpManager = mcpManager;
  }

  start(tasks: ScheduledTask[]): void {
    this.stop();
    this.tasks = tasks;

    const enabled = tasks.filter((t) => t.enabled);
    if (enabled.length === 0) return;

    const hasCron = enabled.some((t) => t.cron);
    const hasInterval = enabled.some((t) => !t.cron && (t.intervalMinutes ?? 0) >= 1);
    const hasSave = enabled.some((t) => (t.onSave?.length ?? 0) > 0);

    // Interval-based tasks: one timer per task
    if (hasInterval) {
      for (const task of enabled) {
        if (task.cron || !task.intervalMinutes || task.intervalMinutes < 1) continue;
        const intervalMs = task.intervalMinutes * 60 * 1000;
        this.logger?.info(`Scheduled task "${task.name}" every ${task.intervalMinutes}m`);
        const timer = setInterval(() => void this.runTask(task), intervalMs);
        this.timers.set(task.name, timer);
      }
    }

    // Cron tasks: one shared once-per-minute tick
    if (hasCron) {
      for (const task of enabled) {
        if (!task.cron) continue;
        const parsed = parseCron(task.cron);
        if (!parsed) {
          this.logger?.warn(`Scheduled task "${task.name}": invalid cron expression "${task.cron}" — skipped`);
          continue;
        }
        this.parsedCrons.set(task.name, parsed);
        this.logger?.info(`Scheduled task "${task.name}" on cron "${task.cron}"`);
      }

      if (this.parsedCrons.size > 0) {
        this.cronTimer = setInterval(() => {
          const now = new Date();
          for (const task of enabled) {
            const parsed = this.parsedCrons.get(task.name);
            if (parsed && cronMatches(parsed, now)) {
              void this.runTask(task);
            }
          }
        }, 60_000);
      }
    }

    // File-save tasks: one workspace listener shared across all onSave tasks
    if (hasSave) {
      this.saveSub = workspace.onDidSaveTextDocument((doc) => {
        const saved = doc.uri.fsPath.replace(/\\/g, '/');
        for (const task of enabled) {
          if (!task.onSave?.length) continue;
          const matches = task.onSave.some((g) => matchGlob(g, saved) || matchGlob(g, path.basename(saved)));
          if (matches) {
            this.logger?.info(`Scheduled task "${task.name}" triggered by save: ${path.basename(saved)}`);
            void this.runTask(task);
          }
        }
      });
    }
  }

  /** Run a named task immediately, regardless of its trigger configuration. */
  async runNow(taskName: string): Promise<void> {
    const task = this.tasks.find((t) => t.name === taskName);
    if (!task) throw new Error(`No scheduled task named "${taskName}"`);
    await this.runTask(task);
  }

  getTaskNames(): string[] {
    return this.tasks.filter((t) => t.enabled).map((t) => t.name);
  }

  getRunHistory(): readonly TaskRunRecord[] {
    return this.runHistory;
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    this.logger?.info(`Running scheduled task: ${task.name}`);
    const startedAt = Date.now();
    const release = await fileLock.acquire(task.name);

    try {
      const config = getConfig();
      const client = new SideCarClient(config.model, config.baseUrl, config.apiKey);
      const messages = [{ role: 'user' as const, content: task.prompt }];
      const abortController = new AbortController();

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

      if (gateCheck.dirty) {
        this.logger?.warn(
          `[${task.name}] Target files dirty: ${gateCheck.dirtyFiles.join(', ')}. Using Shadow Workspace.`,
        );
        await runAgentLoopInSandbox(client, messages, callbacks, abortController.signal, options, {
          forceShadow: true,
          deferPrompt: true,
        });
      } else {
        await runAgentLoop(client, messages, callbacks, abortController.signal, options);
      }

      this.recordRun(task.name, startedAt, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.error(`[${task.name}] Failed: ${msg}`);
      this.recordRun(task.name, startedAt, false, msg);
    } finally {
      release();
    }
  }

  private recordRun(taskName: string, startedAt: number, success: boolean, errorMessage?: string): void {
    const record: TaskRunRecord = { taskName, startedAt, finishedAt: Date.now(), success, errorMessage };
    this.runHistory.unshift(record);
    // Cap history to last 100 runs
    if (this.runHistory.length > 100) this.runHistory.length = 100;
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    this.parsedCrons.clear();
    this.saveSub?.dispose();
    this.saveSub = null;
  }

  dispose(): void {
    this.stop();
  }
}
