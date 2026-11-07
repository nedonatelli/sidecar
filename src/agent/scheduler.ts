import { workspace, Disposable } from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

/** Write a scheduled run's unapplied patch under .sidecar/scheduled-patches/; returns its path, or null. */
async function savePendingPatch(taskName: string, startedAt: number, diff: string): Promise<string | null> {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return null;
  try {
    const dir = path.join(root, '.sidecar', 'scheduled-patches');
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${taskName.replace(/[^\w.-]+/g, '_')}-${stamp}.patch`);
    await fs.promises.writeFile(file, diff, 'utf-8');
    return file;
  } catch {
    return null;
  }
}

/**
 * The paths an `onSave` glob is tested against for one saved file: the path
 * relative to the workspace folder that holds it, then the absolute path, then
 * the bare file name. All forward-slash. Globs are anchored at both ends, so
 * while only the last two were tried, a workspace-relative pattern such as
 * "src/**" never fired (#431).
 * The prefix test ignores case and separators, as on Windows a URI's fsPath and
 * a folder's can differ in drive-letter case. The innermost folder wins when
 * folders nest. A file outside every folder has no relative form and is tested
 * against the absolute path and the file name only.
 */
export function onSaveMatchPaths(fsPath: string, folderPaths: readonly string[]): string[] {
  const abs = fsPath.replace(/\\/g, '/');
  let rel: string | undefined;
  for (const folder of folderPaths) {
    const root = folder.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!root || !abs.toLowerCase().startsWith(root.toLowerCase() + '/')) continue;
    const candidate = abs.slice(root.length + 1);
    if (rel === undefined || candidate.length < rel.length) rel = candidate;
  }
  return [...(rel !== undefined ? [rel] : []), abs, path.posix.basename(abs)];
}

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
        const folders = (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        const candidates = onSaveMatchPaths(doc.uri.fsPath, folders);
        for (const task of enabled) {
          if (!task.onSave?.length) continue;
          const matches = task.onSave.some((g) => candidates.some((p) => matchGlob(g, p)));
          if (matches) {
            this.logger?.info(`Scheduled task "${task.name}" triggered by save: ${candidates[0]}`);
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
        const outcome = await runAgentLoopInSandbox(client, messages, callbacks, abortController.signal, options, {
          forceShadow: true,
          deferPrompt: true,
        });
        // The shadow's changes come back as a patch nobody applies. It was
        // dropped and the run recorded as a success (#115): keep it on disk
        // and record that nothing was applied.
        if (outcome.pendingDiff) {
          const saved = await savePendingPatch(task.name, startedAt, outcome.pendingDiff);
          const msg =
            `changes not applied: ${gateCheck.dirtyFiles.join(', ')} had uncommitted changes. ` +
            (saved ? `The patch is saved at ${saved} (apply it with git apply).` : 'The patch could not be saved.');
          this.logger?.warn(`[${task.name}] ${msg}`);
          this.recordRun(task.name, startedAt, false, msg);
          return;
        }
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
