import { window, type Terminal, type Disposable } from 'vscode';
import type { ShellExecuteOptions, ShellResult } from './shellSession.js';

/**
 * Shape of VS Code's `TerminalShellIntegration.executeCommand` return value.
 * Typed locally because the `vscode` module typings may not be available in
 * every test environment — the dynamic shape is all we rely on.
 */
interface TerminalShellExecution {
  read(): AsyncIterable<string>;
}

/**
 * The end-of-execution event VS Code fires after `executeCommand` completes.
 * Carries the exit code — the primary reason we listen for it, since
 * `TerminalShellExecution.read()` yields stdout only.
 */
interface TerminalShellExecutionEndEvent {
  execution: TerminalShellExecution;
  exitCode: number | undefined;
}

export interface AgentTerminalOptions {
  /** Display name of the reusable terminal. Default `"SideCar Agent"`. */
  terminalName?: string;
  /**
   * Max ms to wait for `shellIntegration` to become available on a freshly
   * created terminal. Shell integration attaches asynchronously after the
   * terminal's shell loads its init script. Default 2000.
   */
  shellIntegrationTimeoutMs?: number;
}

/**
 * Reusable terminal that runs agent-initiated shell commands through
 * VS Code's shell-integration API so the user sees exactly what the agent
 * is running. Complements `ShellSession` (which uses `child_process.spawn`
 * for hidden subprocess work).
 *
 * Classifier (enforced at the call site in `tools/shell.ts`): any
 * `run_command` tool call routes here; internal parse-only tools
 * (`git_diff`, `grep` subprocesses, `read_file` probes) stay on
 * `child_process` so their output isn't rendered as terminal noise.
 *
 * Returns `null` from `execute()` when `shellIntegration` is unavailable
 * (bare shells without the integration script loaded, or VS Code <1.93).
 * The caller is expected to fall back to `ShellSession` in that case.
 *
 * Why shell integration and not `sendText` + capture: `sendText` renders
 * in the terminal but there's no supported way to capture its output or
 * observe its exit code. Shell integration gives both plus inline-error
 * annotations and command-navigation affordances the user can scroll
 * through in their terminal panel afterwards.
 */
export class AgentTerminalExecutor implements Disposable {
  private terminal: Terminal | null = null;
  private readonly terminalName: string;
  private readonly shellIntegrationTimeoutMs: number;
  private disposables: Disposable[] = [];

  constructor(options: AgentTerminalOptions = {}) {
    this.terminalName = options.terminalName ?? 'SideCar Agent';
    this.shellIntegrationTimeoutMs = options.shellIntegrationTimeoutMs ?? 2000;

    this.disposables.push(
      window.onDidCloseTerminal((t) => {
        if (t === this.terminal) this.terminal = null;
      }),
    );
  }

  /**
   * Run a command in the reusable agent terminal.
   *
   * Returns a `ShellResult` on success (streamed output + exit code from
   * `onDidEndTerminalShellExecution`), or `null` if shell integration is
   * unavailable so the caller can fall back to `ShellSession`.
   */
  async execute(command: string, options: ShellExecuteOptions = {}): Promise<ShellResult | null> {
    const terminal = await this.getReadyTerminal();
    if (!terminal) return null;

    const integration = (
      terminal as unknown as {
        shellIntegration?: { executeCommand?: (cmd: string) => TerminalShellExecution };
      }
    ).shellIntegration;
    if (!integration?.executeCommand) return null;

    let execution: TerminalShellExecution;
    try {
      execution = integration.executeCommand(command);
    } catch {
      return null;
    }

    // Bring the terminal into view without stealing focus from the editor.
    terminal.show(true);

    const { timeout = 120_000, onOutput, signal } = options;

    return new Promise<ShellResult>((resolve) => {
      let exitCode = 0;
      let output = '';
      let timedOut = false;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        endListener.dispose();
        closeListener.dispose();
        resolve({ stdout: output, exitCode, timedOut });
      };

      // Signal handlers — timeout and abort both best-effort SIGINT the
      // command by sending ^C (0x03) to the terminal stdin. We don't wait
      // for the end event after that; the user gets a result immediately
      // indicating the command didn't complete cleanly, and the process
      // may or may not actually die (some programs ignore SIGINT). That
      // matches the semantics of ShellSession's timeout/abort paths and
      // avoids hanging here forever if the underlying process ignores ^C.
      const onAbort = () => {
        timedOut = true;
        output += '\n\n⚠️ Command aborted';
        try {
          terminal.sendText('\x03', false);
        } catch {
          // Terminal may be disposed mid-abort
        }
        finish();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        output += `\n\n⚠️ Command timed out after ${timeout / 1000}s`;
        try {
          terminal.sendText('\x03', false);
        } catch {
          // Terminal may be disposed mid-timeout
        }
        finish();
      }, timeout);
      signal?.addEventListener('abort', onAbort, { once: true });

      // If the user closes the terminal mid-command, exit cleanly with
      // what we captured so far rather than hanging forever.
      const closeListener = window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          output += '\n\n⚠️ Terminal closed before command completed';
          finish();
        }
      });

      // The primary completion signal — onDidEndTerminalShellExecution
      // fires with the exit code once the execution finishes. Correlate
      // by execution-object identity (the `ev.execution === execution`
      // check) since this is a global event that fires for every
      // execution in every terminal.
      const endListener = window.onDidEndTerminalShellExecution((ev: TerminalShellExecutionEndEvent) => {
        if (ev.execution === execution) {
          exitCode = ev.exitCode ?? 0;
          finish();
        }
      });

      // Drain stdout. `read()` completes when the execution finishes OR
      // the terminal is disposed. Errors from `read()` (e.g. terminal
      // disposed mid-stream) are swallowed — the end-event listener or
      // the close listener will resolve the promise with whatever output
      // we captured up to that point.
      (async () => {
        try {
          for await (const chunk of execution.read()) {
            if (resolved) break;
            output += chunk;
            onOutput?.(chunk);
          }
        } catch {
          // read() can throw if the terminal is disposed mid-stream.
          // Let the end/close listeners resolve the promise.
        }
      })();
    });
  }

  /**
   * Get the reusable terminal, creating it if needed and waiting for its
   * `shellIntegration` to attach. Returns `null` if integration never
   * becomes available within `shellIntegrationTimeoutMs`.
   */
  private async getReadyTerminal(): Promise<Terminal | null> {
    // Reuse existing terminal if it still has shellIntegration attached.
    if (this.terminal && this.terminal.exitStatus === undefined) {
      const integration = (this.terminal as unknown as { shellIntegration?: unknown }).shellIntegration;
      if (integration) return this.terminal;
      // Terminal exists but integration was lost (user ran an integration-
      // breaking command? shell was replaced?). Recreate.
      this.terminal.dispose();
      this.terminal = null;
    }

    this.terminal = window.createTerminal(this.terminalName);

    // Poll for shellIntegration — it attaches asynchronously after the
    // terminal's shell loads VS Code's integration script.
    const start = Date.now();
    while (Date.now() - start < this.shellIntegrationTimeoutMs) {
      const integration = (this.terminal as unknown as { shellIntegration?: unknown }).shellIntegration;
      if (integration) return this.terminal;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  dispose(): void {
    this.terminal?.dispose();
    this.terminal = null;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
