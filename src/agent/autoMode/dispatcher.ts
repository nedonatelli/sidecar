import { window, StatusBarAlignment, type StatusBarItem, type Disposable } from 'vscode';
import * as fs from 'fs/promises';
import { runAgentLoopInSandbox } from '../shadow/sandbox.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';
import type { MCPManager } from '../mcpManager.js';
import type { AgentLogger } from '../logger.js';
import { getConfig } from '../../config/settings.js';
import { parseBacklog, nextPendingItem, markItemDone, backlogStats, type BacklogItem } from './backlogParser.js';

export interface AutoModeSessionResult {
  tasksAttempted: number;
  tasksSucceeded: number;
  tasksFailed: number;
  stoppedReason: 'completed' | 'task-cap' | 'runtime-cap' | 'halted-on-failure' | 'cancelled';
}

export interface AutoModeCallbacks {
  /** Called when a task starts. N and total are 1-based. */
  onTaskStart: (item: BacklogItem, n: number, total: number) => void;
  /** Called when a task completes successfully. */
  onTaskDone: (item: BacklogItem, n: number, total: number) => void;
  /** Called when a task fails. `error` is the thrown value. */
  onTaskError: (item: BacklogItem, error: unknown) => void;
  /** Called when the session ends. */
  onSessionEnd: (result: AutoModeSessionResult) => void;
}

export interface AutoModeOptions {
  backlogPath: string;
  maxTasksPerSession: number;
  maxRuntimeMs: number;
  haltOnFailure: boolean;
  interTaskCooldownMs: number;
  mcpManager?: MCPManager;
  logger?: AgentLogger;
  abortSignal?: AbortSignal;
}

/**
 * Auto Mode dispatcher (v0.73.0 core loop).
 *
 * Reads the backlog file at `options.backlogPath`, picks unchecked items
 * in order, runs each through `runAgentLoopInSandbox` with autonomous
 * approval, marks the item `- [x]` on success, and advances to the next.
 *
 * Stops when all items are done, the task cap / runtime cap is hit, or
 * `haltOnFailure` triggers. Each task's agent output is forwarded via the
 * `agentCallbacks` parameter so the caller can stream it to the chat UI.
 *
 * `options.abortSignal` cancels the current task and prevents further tasks
 * from starting — it is forwarded directly to `runAgentLoopInSandbox`.
 */
export async function runAutoMode(
  client: SideCarClient,
  options: AutoModeOptions,
  agentCallbacks: AgentCallbacks,
  callbacks: AutoModeCallbacks,
): Promise<AutoModeSessionResult> {
  const startedAt = Date.now();
  let tasksAttempted = 0;
  let tasksSucceeded = 0;
  let tasksFailed = 0;

  const signal = options.abortSignal ?? new AbortController().signal;

  for (;;) {
    // --- Session guards ---
    if (signal.aborted) {
      return finish('cancelled');
    }
    if (Date.now() - startedAt >= options.maxRuntimeMs) {
      return finish('runtime-cap');
    }
    if (tasksAttempted >= options.maxTasksPerSession) {
      return finish('task-cap');
    }

    // --- Read + parse backlog ---
    let content: string;
    try {
      content = await fs.readFile(options.backlogPath, 'utf8');
    } catch {
      // Backlog file missing or unreadable — treat as empty
      return finish('completed');
    }

    const items = parseBacklog(content);
    const item = nextPendingItem(items);
    if (!item) {
      return finish('completed');
    }

    const stats = backlogStats(items);
    const taskN = tasksAttempted + 1;
    const totalPending = stats.pending;

    callbacks.onTaskStart(item, taskN, totalPending);
    tasksAttempted++;

    // --- Apply per-item sentinel overrides ---
    const { sentinels } = item;
    if (sentinels.model) {
      client.setTurnOverride(sentinels.model);
    }

    // --- Run the agent loop ---
    const taskPrompt = buildTaskPrompt(item.text);
    const messages = [{ role: 'user' as const, content: taskPrompt }];

    const config = getConfig();
    try {
      await runAgentLoopInSandbox(
        client,
        messages,
        agentCallbacks,
        signal,
        {
          approvalMode: 'autonomous',
          maxIterations: config.agentMaxIterations,
          maxTokens: config.agentMaxTokens,
          ...(options.mcpManager ? { mcpManager: options.mcpManager } : {}),
          ...(options.logger ? { logger: options.logger } : {}),
        },
        {
          forceShadow: sentinels.shadowMode === 'always',
          suppressShadow: sentinels.shadowMode === 'off',
        },
      );

      // Mark done on success
      const fresh = await fs.readFile(options.backlogPath, 'utf8');
      await fs.writeFile(options.backlogPath, markItemDone(fresh, item.lineIndex), 'utf8');

      tasksSucceeded++;
      callbacks.onTaskDone(item, taskN, totalPending);
    } catch (err) {
      tasksFailed++;
      callbacks.onTaskError(item, err);
      if (options.haltOnFailure) {
        return finish('halted-on-failure');
      }
    } finally {
      // Restore model override after every task (success or failure)
      if (sentinels.model) {
        client.setTurnOverride(null);
      }
    }

    // --- Inter-task cooldown (skip on last task or cancellation) ---
    if (options.interTaskCooldownMs > 0 && !signal.aborted) {
      await sleep(options.interTaskCooldownMs, signal);
    }
  }

  function finish(reason: AutoModeSessionResult['stoppedReason']): AutoModeSessionResult {
    const result: AutoModeSessionResult = { tasksAttempted, tasksSucceeded, tasksFailed, stoppedReason: reason };
    callbacks.onSessionEnd(result);
    return result;
  }
}

function buildTaskPrompt(taskText: string): string {
  return (
    `You are working through an automated backlog. Your current task is:\n\n` +
    `**${taskText}**\n\n` +
    `Complete this task fully. When you are done, stop — do not pick up other tasks.`
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Status bar helper — thin wrapper so extension.ts can manage it simply
// ---------------------------------------------------------------------------

export class AutoModeStatusBar implements Disposable {
  private readonly item: StatusBarItem;

  constructor() {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 10);
    this.item.command = 'sidecar.stopAutoMode';
    this.item.tooltip = 'Auto Mode running — click to stop';
  }

  show(taskN: number, total: number): void {
    this.item.text = `$(sync~spin) Auto Mode: task ${taskN}/${total}`;
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
