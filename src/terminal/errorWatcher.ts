import { window, type Disposable } from 'vscode';

/**
 * Information about a failed terminal command captured by TerminalErrorWatcher.
 * Passed to the `onError` callback so consumers can render notifications,
 * forward to a chat agent, etc.
 */
export interface TerminalErrorEvent {
  commandLine: string;
  exitCode: number;
  cwd: string | undefined;
  output: string;
  terminalName: string;
}

export interface TerminalErrorWatcherOptions {
  /** Returns true when interception is enabled (re-checked per event). */
  enabled: () => boolean;
  /** Terminal names to skip — typically SideCar's own internal terminal. */
  ignoredTerminalNames?: Set<string>;
  /** Called when a non-zero exit is detected and not deduped. */
  onError: (event: TerminalErrorEvent) => void;
  /** Cap on captured output length (tail-keeping). Default 4000. */
  maxOutputChars?: number;
  /** Window in ms within which the same command line is deduped. Default 30000. */
  cooldownMs?: number;
}

const DEFAULT_MAX_OUTPUT = 4000;
const DEFAULT_COOLDOWN_MS = 30_000;

// stripAnsi lives in ./ansi.ts so shellSession can import it without
// pulling in the VS Code event loop dependencies this file has. We
// re-import and re-export here so existing callers (including
// errorWatcher's own internal usage below) keep working without churn.
import { stripAnsi } from './ansi.js';
export { stripAnsi };

/**
 * Pure decision function: given an exit code, terminal name, and the recent
 * dedup map, decide whether this failure is worth reporting.
 *
 * Extracted so it can be unit-tested without booting the VS Code event loop.
 */
export function shouldReportFailure(
  commandLine: string,
  exitCode: number | undefined,
  terminalName: string,
  ignoredNames: Set<string> | undefined,
  recentErrors: Map<string, number>,
  cooldownMs: number,
  now: number = Date.now(),
): boolean {
  if (exitCode === undefined || exitCode === 0) return false;
  if (!commandLine || !commandLine.trim()) return false;
  if (ignoredNames && ignoredNames.has(terminalName)) return false;
  const last = recentErrors.get(commandLine);
  if (last !== undefined && now - last < cooldownMs) return false;
  return true;
}

/**
 * Watches the integrated terminal for failed commands. When VS Code reports
 * a non-zero exit code, captures the command line, working directory, and a
 * tail of the streamed output, then invokes the `onError` callback.
 *
 * Requires VS Code shell integration (POSIX shells, PowerShell). On older
 * VS Code versions or when shell integration is unavailable, the watcher is
 * effectively a no-op — the start/end events simply never fire.
 */
export class TerminalErrorWatcher implements Disposable {
  private disposables: Disposable[] = [];
  private recentErrors = new Map<string, number>();
  private maxOutputChars: number;
  private cooldownMs: number;
  private disposeController = new AbortController();

  constructor(private options: TerminalErrorWatcherOptions) {
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    // Feature-detect shell execution events (added in VS Code 1.93). If the
    // host doesn't expose them we silently degrade — the user just won't get
    // automatic interception, which is acceptable.
    const startEvent = (window as { onDidStartTerminalShellExecution?: unknown }).onDidStartTerminalShellExecution;
    if (typeof startEvent !== 'function') return;

    this.disposables.push(
      window.onDidStartTerminalShellExecution((event) => {
        // Fire-and-forget: per-execution async pipeline owns its own state.
        void this.handleExecution(event);
      }),
    );
  }

  /**
   * Per-execution pipeline:
   *   1. Subscribe to the matching end event for this specific execution.
   *   2. Drain the read() stream concurrently into a tail-capped buffer.
   *   3. When the end event fires (or the read loop closes), report if the
   *      exit code was non-zero and the failure passes dedup checks.
   */
  private async handleExecution(startEvent: import('vscode').TerminalShellExecutionStartEvent): Promise<void> {
    if (!this.options.enabled()) return;
    if (this.options.ignoredTerminalNames?.has(startEvent.terminal.name)) return;

    // Set up a one-shot waiter for THIS execution's end event before we
    // start draining output, so we don't miss it. The disposeController
    // signal lets dispose() cancel in-flight executions cleanly so the
    // endPromise doesn't hang after extension deactivation.
    const disposeSignal = this.disposeController.signal;
    const endPromise = new Promise<import('vscode').TerminalShellExecutionEndEvent | null>((resolve) => {
      if (disposeSignal.aborted) {
        resolve(null);
        return;
      }
      const onDispose = () => resolve(null);
      disposeSignal.addEventListener('abort', onDispose, { once: true });
      const sub = window.onDidEndTerminalShellExecution((endEvent) => {
        if (endEvent.execution === startEvent.execution) {
          disposeSignal.removeEventListener('abort', onDispose);
          sub.dispose();
          resolve(endEvent);
        }
      });
      this.disposables.push(sub);
    });

    let output = '';
    let stopped = false;
    const max = this.maxOutputChars;

    const readLoop = (async () => {
      try {
        for await (const chunk of startEvent.execution.read()) {
          if (stopped) break;
          output += chunk;
          // Tail-cap: keep at most ~2x max so we don't reallocate every chunk,
          // then trim down to max once we exceed the upper bound.
          if (output.length > max * 2) {
            output = output.slice(-max);
          }
        }
      } catch {
        /* read errors are non-fatal — we still report what we captured */
      }
    })();

    // Wait for the end event. Then give the read loop a brief moment to
    // drain any final buffered chunks before we lock in the captured output.
    const endEvent = await endPromise;
    // null means dispose() was called while we were waiting — bail out cleanly.
    if (!endEvent) return;
    await Promise.race([readLoop, new Promise((r) => setTimeout(r, 100))]);
    stopped = true;

    // Re-check enabled() — the user may have toggled the setting mid-command.
    if (!this.options.enabled()) return;

    const commandLine = endEvent.execution.commandLine.value || '';
    if (
      !shouldReportFailure(
        commandLine,
        endEvent.exitCode,
        endEvent.terminal.name,
        this.options.ignoredTerminalNames,
        this.recentErrors,
        this.cooldownMs,
      )
    ) {
      return;
    }

    const now = Date.now();
    this.recentErrors.set(commandLine, now);
    this.pruneRecentErrors(now);

    const finalOutput = stripAnsi(output.length > max ? output.slice(-max) : output).trim();

    this.options.onError({
      commandLine,
      // Non-undefined non-zero — checked by shouldReportFailure above.
      exitCode: endEvent.exitCode as number,
      cwd: endEvent.execution.cwd?.fsPath,
      output: finalOutput,
      terminalName: endEvent.terminal.name,
    });
  }

  private pruneRecentErrors(now: number): void {
    const ttl = this.cooldownMs * 4;
    for (const [key, ts] of this.recentErrors) {
      if (now - ts > ttl) this.recentErrors.delete(key);
    }
  }

  dispose(): void {
    // Signal all in-flight handleExecution calls to resolve their endPromise
    // with null so they exit cleanly rather than hanging indefinitely.
    this.disposeController.abort();
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* best-effort */
      }
    }
    this.disposables = [];
    this.recentErrors.clear();
  }
}
