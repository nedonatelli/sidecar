import { window } from 'vscode';
import { dispatchForks, type ForkDispatchBatchResult } from './forkDispatcher.js';
import { reviewForkBatch, type ForkReviewDeps, type ForkReviewOutcome } from './forkReview.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';

// ---------------------------------------------------------------------------
// Fork command entry point (v0.67 chunk 6).
//
// Wraps `dispatchForks` + `reviewForkBatch` into a single end-to-end
// flow: prompt the user for a task (or accept one pre-supplied by the
// `/fork <task>` slash command), spawn N parallel approaches, then
// surface the pick-the-winner review once every fork settles.
//
// The handler is extracted from the command registration site so it's
// testable through an injectable `ForkCommandUi` — tests drive every
// cancel path + the dispatched/review branches without touching
// `window.*`.
// ---------------------------------------------------------------------------

export interface ForkCommandUi {
  /** Free-form text prompt. Returns undefined on cancel. */
  showInputBox(prompt: string, placeholder?: string): Promise<string | undefined>;
  /** Fire-and-forget info toast. */
  showInfo(message: string): void;
  /** Fire-and-forget error toast. */
  showError(message: string): void;
}

export interface ForkCommandDeps {
  /** UI surface — real shim in production, fake in tests. */
  ui: ForkCommandUi;
  /** Fresh `SideCarClient`. Tests pass a stub. */
  createClient: () => SideCarClient;
  /** Abort signal source for the batch. Defaults to a never-aborted signal. */
  signal?: AbortSignal;
  /**
   * Optional pre-supplied task — set by the `/fork <task>` slash
   * command. When present the input-box prompt is skipped entirely.
   * When absent (command-palette invocation) the user is prompted.
   */
  preFilledTask?: string;
  /** Runs the dispatch. Indirection lets tests assert inputs without spinning up forks. */
  dispatch?: typeof dispatchForks;
  /** Runs the aggregated review after dispatch. */
  review?: typeof reviewForkBatch;
  /**
   * Deps forwarded to the review flow (ui + mainRoot). Required when
   * the dispatched batch has reviewable entries; omit to short-
   * circuit review (headless / programmatic callers).
   */
  reviewDeps?: ForkReviewDeps;
  /** Callback sink for LLM output during fork runs. */
  callbacks?: AgentCallbacks;
  /** Config values from `sidecar.fork.*`. */
  config: ForkCommandConfig;
}

export interface ForkCommandConfig {
  readonly enabled: boolean;
  readonly defaultCount: number;
  readonly maxConcurrent: number;
}

/**
 * Outcome shape — structured so the caller can log, telemetry, or
 * react to every terminal state. `disabled` fires before any UI
 * touches the user; `cancelled` covers every no-op path; `dispatched`
 * carries the batch result + optional review outcome for downstream
 * surfaces (e.g. a future webview Fork panel).
 */
export type ForkCommandOutcome =
  | { mode: 'disabled'; message: string }
  | {
      mode: 'cancelled';
      reason: 'empty-task' | 'task-cancelled';
    }
  | {
      mode: 'dispatched';
      task: string;
      batch: ForkDispatchBatchResult;
      review?: ForkReviewOutcome;
    };

/**
 * End-to-end fork dispatch flow. Steps:
 *   1. Gate on `sidecar.fork.enabled`.
 *   2. Resolve the task (preFilled from `/fork`, or prompt the user).
 *   3. Dispatch N forks (from `config.defaultCount`) with the signal
 *      + callbacks + config-driven concurrency cap.
 *   4. Hand the batch to `reviewForkBatch` when `reviewDeps` is
 *      supplied; otherwise return the batch unreviewed for the
 *      headless caller to handle.
 */
export async function runForkDispatchCommand(deps: ForkCommandDeps): Promise<ForkCommandOutcome> {
  if (!deps.config.enabled) {
    const message = 'Fork & Parallel Solve is disabled. Enable `sidecar.fork.enabled` to run /fork dispatches.';
    deps.ui.showInfo(message);
    return { mode: 'disabled', message };
  }

  let task = deps.preFilledTask;
  if (task === undefined) {
    task = await deps.ui.showInputBox(
      'Task for parallel forks',
      'e.g. "refactor the auth middleware to use async/await"',
    );
    if (task === undefined) {
      return { mode: 'cancelled', reason: 'task-cancelled' };
    }
  }
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    deps.ui.showInfo('Empty task — nothing to dispatch.');
    return { mode: 'cancelled', reason: 'empty-task' };
  }

  const dispatch = deps.dispatch ?? dispatchForks;
  const client = deps.createClient();
  const signal = deps.signal ?? new AbortController().signal;
  const callbacks = deps.callbacks ?? silentCallbacks();

  try {
    const batch = await dispatch(client, callbacks, {
      task: trimmed,
      numForks: deps.config.defaultCount,
      maxConcurrent: deps.config.maxConcurrent,
      signal,
    });
    summarizeBatch(deps.ui, batch);

    let review: ForkReviewOutcome | undefined;
    if (deps.reviewDeps) {
      const runReview = deps.review ?? reviewForkBatch;
      review = await runReview(batch, deps.reviewDeps);
    }
    return { mode: 'dispatched', task: trimmed, batch, review };
  } catch (err) {
    deps.ui.showError(`Fork dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function summarizeBatch(ui: ForkCommandUi, batch: ForkDispatchBatchResult): void {
  const ok = batch.results.filter((r) => r.success).length;
  const failed = batch.results.length - ok;
  const pieces = [`${ok} succeeded`];
  if (failed > 0) pieces.push(`${failed} failed`);
  const seconds = (batch.elapsedMs / 1000).toFixed(1);
  ui.showInfo(`Forks: ${pieces.join(', ')} in ${seconds}s.`);
}

function silentCallbacks(): AgentCallbacks {
  return {
    onText: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onDone: () => undefined,
  };
}

/**
 * Production UI adapter. `extension.ts` wires this into the
 * `sidecar.fork.dispatch` command-palette entry and the `/fork`
 * slash-command router.
 */
export function createDefaultForkCommandUi(): ForkCommandUi {
  return {
    async showInputBox(prompt, placeholder) {
      return window.showInputBox({ prompt, placeHolder: placeholder });
    },
    showInfo(message) {
      void window.showInformationMessage(message);
    },
    showError(message) {
      void window.showErrorMessage(message);
    },
  };
}
