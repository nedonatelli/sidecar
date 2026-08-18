import {
  env,
  window,
  type Terminal,
  type Disposable,
  type TerminalShellExecution,
  type TerminalShellExecutionEndEvent,
} from 'vscode';
import type { ShellExecuteOptions, ShellResult } from './shellSession.js';
import { stripAnsi } from './ansi.js';

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
/**
 * Wrap a command so it cannot block reading stdin — the terminal-path twin of
 * the ShellSession fix, with one crucial difference in cause.
 *
 * ShellSession's bug was a completion sentinel written to stdin that commands
 * could EAT. There is no sentinel here: this path uses VS Code shell
 * integration and reads the exit code from onDidEndTerminalShellExecution.
 * `cat` hangs for the ordinary reason — a terminal's stdin never reaches EOF,
 * because a human could type into it. So an agent command that waits for input
 * waits forever, and the loop burns its whole timeout (measured: 120s on a bare
 * `cat`, in the DEFAULT configuration).
 *
 * The wrapper is dialect-specific and this terminal is the USER'S shell —
 * `window.createTerminal(name)` takes their default profile, so it may be fish,
 * nushell or PowerShell, where `{ …; } < /dev/null` is a syntax error. Applying
 * a POSIX wrapper blindly would turn a hang into a broken command on EVERY
 * call, which is strictly worse. So: wrap only where the dialect is known,
 * leave everything else exactly as it was.
 *
 * Grouped rather than appended because `<cmd> < /dev/null` binds the redirect to
 * the LAST element of a pipeline and would break `echo x | cat`.
 */
export function guardStdin(command: string, shellPath = env.shell): string {
  const shell = (shellPath || '').toLowerCase();
  const posix = /(^|\/)(bash|zsh|sh|dash|ksh)(\d|\.exe)?$/.test(shell);
  if (posix) return `{ ${command}\n} < /dev/null`;
  if (/cmd\.exe$/.test(shell)) return `(${command}) < NUL`;
  // fish, nushell, PowerShell, or anything unrecognised: leave alone. A command
  // that hangs is recoverable; a command that cannot parse is not.
  return command;
}

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

    const integration = terminal.shellIntegration;
    if (!integration?.executeCommand) return null;

    let execution: TerminalShellExecution;
    try {
      execution = integration.executeCommand(guardStdin(command));
    } catch {
      return null;
    }

    // Bring the terminal into view without stealing focus from the editor.
    terminal.show(true);

    const { timeout = 120_000, maxTimeout = 30 * 60_000, onOutput: rawOnOutput, signal } = options;
    // ShellSession strips escape sequences at both ends; this executor stripped
    // at neither, so everything routed through the VS Code terminal reached the
    // model raw. Observed in a dogfood run: a `cat` returned
    // `]633;C[1m[7m%[27m[1m[0m` around two lines of real output — a
    // shell-integration OSC marker plus zsh prompt styling. The command's output
    // was correct, so nothing failed; it is tokens of noise on every terminal
    // command, and a model has to decide whether `[1m[7m%[27m` is data.
    //
    // Safe to strip, checked rather than assumed: the exit code comes from
    // `onDidEndTerminalShellExecution`'s event object, not from parsing `]633;`
    // markers out of the stream, so nothing downstream depends on seeing them.
    const onOutput = rawOnOutput ? (chunk: string) => rawOnOutput(stripAnsi(chunk)) : undefined;

    return new Promise<ShellResult>((resolve) => {
      let exitCode = 0;
      let output = '';
      let timedOut = false;
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        signal?.removeEventListener('abort', onAbort);
        endListener.dispose();
        closeListener.dispose();
        // Stripped here and not per-chunk, because `output` is accumulated from
        // raw chunks: an escape sequence split across a chunk boundary survives
        // per-chunk stripping and is only removable once the whole string exists.
        resolve({ stdout: stripAnsi(output), exitCode, timedOut });
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
      // Idle-based, not wall-clock: the guard is for a HUNG process, not a slow
      // one. Any output resets the clock, so a long-but-progressing command (a
      // test suite, a build) runs to completion while a silent hang still dies.
      // `maxTimeout` backstops output that never stops (`tail -f`, dev server).
      const killTimedOut = (reason: string) => {
        timedOut = true;
        output += `\n\n⚠️ Command timed out after ${reason}`;
        try {
          terminal.sendText('\x03', false);
        } catch {
          // Terminal may be disposed mid-timeout
        }
        finish();
      };
      const idleReason = `${timeout / 1000}s with no output`;
      let timer = setTimeout(() => killTimedOut(idleReason), timeout);
      const hardTimer = setTimeout(() => killTimedOut(`${maxTimeout / 1000}s (absolute limit)`), maxTimeout);
      const armIdle = () => {
        if (resolved) return;
        clearTimeout(timer);
        timer = setTimeout(() => killTimedOut(idleReason), timeout);
      };
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
            armIdle();
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
      if (this.terminal.shellIntegration) return this.terminal;
      // Terminal exists but integration was lost (user ran an integration-
      // breaking command? shell was replaced?). Recreate.
      this.terminal.dispose();
      this.terminal = null;
    }

    this.terminal = window.createTerminal(this.terminalName);

    // Poll for shellIntegration — it attaches asynchronously after the
    // terminal's shell loads VS Code's integration script. The onDidCloseTerminal
    // listener can null this.terminal between loop iterations, so guard each access.
    const start = Date.now();
    while (Date.now() - start < this.shellIntegrationTimeoutMs) {
      if (!this.terminal) return null;
      if (this.terminal.shellIntegration) return this.terminal;
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
