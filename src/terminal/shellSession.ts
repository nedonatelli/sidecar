import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../system/logger.js';
import { randomBytes } from 'crypto';
import * as os from 'os';
import { MAX_BACKGROUND_COMMANDS } from '../config/constants.js';
import { stripAnsi } from './ansi.js';
import { ManagedChildProcess, getProcessRegistry } from '../agent/processLifecycle.js';
import { isSeatbeltSupported, wrapWithSeatbelt } from './seatbelt.js';

export interface ShellExecuteOptions {
  timeout?: number; // ms, default 120_000
  onOutput?: (chunk: string) => void; // streaming callback
  signal?: AbortSignal; // cancellation
}

export interface ShellResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

interface BackgroundCommand {
  output: string;
  done: boolean;
  exitCode: number | null;
  proc: ManagedChildProcess;
}

// Generate a short alphanumeric sentinel (no special chars to worry about)
function makeSentinel(): string {
  return 'SIDECAR' + randomBytes(8).toString('hex').toUpperCase();
}

/**
 * Per-command state-pollution hardening for POSIX shells.
 *
 * The persistent shell session is a known attack surface: an earlier turn
 * can define a shell function (or alias) that silently reroutes subsequent
 * commands the user later approves in cautious mode. The classic example is
 * `alias ls='rm -rf ~'` followed by a `run_command ls` call that the user
 * sees as innocuous in the approval modal.
 *
 * The session already spawns bash/zsh with startup-file suppression, which
 * turns off alias expansion by default in non-interactive stdin mode. Shell
 * *functions* still persist though, so we reset the namespace before every
 * command. Bash and zsh have different builtin names for this, so we
 * dispatch on the shell path stored at session construction.
 *
 * What we intentionally do NOT reset: cwd, environment variables, exported
 * PATH. Those are the legitimate persistence the shell session exists to
 * provide. PATH poisoning is a separate concern mitigated by the native
 * modal approval for `run_command` in v0.47.0 — the user sees every command
 * string before it runs.
 *
 * Windows cmd.exe doesn't have the same function/alias namespace, so the
 * Windows path is a no-op.
 */
function hardeningPrefixFor(shellPath: string): string {
  const isZsh = shellPath.endsWith('/zsh') || shellPath.endsWith('/zsh5');
  if (isZsh) {
    // zsh: `unalias -m '*'` wipes every alias, `unfunction -m '*'` wipes
    // every function. `-m` with a glob pattern matches all. Suppress
    // stderr in case the shell has no aliases/functions to unset.
    return "unalias -m '*' 2>/dev/null; unfunction -m '*' 2>/dev/null; ";
  }
  // bash (default): `shopt -u expand_aliases` is defense-in-depth on the
  // alias path (non-interactive shells already default to it off).
  // `compgen -A function` lists user-defined functions one per line,
  // which we then iterate and unset with `unset -f`. `builtin` prefixes
  // keep a poisoned alias or function shadowing these commands from
  // short-circuiting the reset.
  return (
    '\\builtin shopt -u expand_aliases 2>/dev/null; ' +
    'while \\builtin read -r __sc_fn; do \\builtin unset -f "$__sc_fn" 2>/dev/null; done < <(\\builtin compgen -A function 2>/dev/null); '
  );
}

/**
 * Persistent shell session that maintains state (cwd, env vars) across commands.
 *
 * Uses a long-lived shell process with sentinel-based command completion detection.
 * Output streams incrementally via the onOutput callback.
 */
export class ShellSession {
  private proc: ChildProcess | null = null;
  private cwd: string;
  private env: Record<string, string>;
  private busy = false;
  /** Resolves once the shell's startup noise has been consumed. See flushStartupBanner. */
  private ready: Promise<void> | null = null;
  private commandQueue: Array<() => void> = [];
  private backgroundCommands = new Map<string, BackgroundCommand>();
  private maxOutputSize: number;
  private isWindows: boolean;
  /** Captured at construction time so the hardening prefix knows which
   *  shell dialect to emit (bash vs zsh vs windows). */
  private shellPath: string;

  /**
   * @param sandboxEnabled  When true and on macOS, wraps shell spawns in
   *   /usr/bin/sandbox-exec. Silently ignored on Windows/Linux.
   *   Note: the AgentTerminalExecutor (VS Code terminal integration) path
   *   is not wrapped — VS Code creates that process outside our spawn call.
   */
  constructor(
    cwd: string,
    env?: Record<string, string>,
    maxOutputSize: number = 10 * 1024 * 1024,
    private readonly sandboxEnabled = false,
  ) {
    this.cwd = cwd;
    this.env = { ...(process.env as Record<string, string>), ...env };
    this.maxOutputSize = maxOutputSize;
    this.isWindows = os.platform() === 'win32';
    this.shellPath = this.isWindows ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash';
    if (this.isWindows) {
      // cmd.exe writes its prompt before each command's output, so every
      // captured result arrived prefixed with `C:\path>`. POSIX shells print no
      // prompt on a pipe; `$_` (a bare newline) is the closest cmd equivalent.
      // Setting PROMPT to the empty string does nothing — cmd falls back to its
      // default — so the value has to be a real, minimal prompt.
      this.env.PROMPT = '$_';
    }
  }

  get isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private ensureProcess(): ChildProcess {
    if (this.isAlive && this.proc) return this.proc;

    const shellPath = this.shellPath;

    // Suppress startup files to avoid unexpected output.
    // bash: --norc --noprofile
    // zsh:  -f (--no-rcs)
    // other: try --norc
    let args: string[];
    if (this.isWindows) {
      args = ['/Q'];
    } else if (shellPath.endsWith('/zsh') || shellPath.endsWith('/zsh5')) {
      args = ['-f'];
    } else {
      args = ['--norc', '--noprofile'];
    }

    let spawnCmd = shellPath;
    let spawnArgs = args;
    if (!this.isWindows && this.sandboxEnabled && isSeatbeltSupported()) {
      ({ cmd: spawnCmd, args: spawnArgs } = wrapWithSeatbelt(shellPath, args, this.cwd));
    }

    this.proc = spawn(spawnCmd, spawnArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => {
      logger.error('[ShellSession] Process error:', err.message);
      this.proc = null;
    });

    this.proc.on('exit', () => {
      this.proc = null;
      this.ready = null;
    });

    this.ready = this.isWindows ? this.flushStartupBanner(this.proc) : Promise.resolve();

    return this.proc;
  }

  /**
   * Swallow cmd.exe's startup banner before any real command can capture it.
   *
   * No flag suppresses it — `/Q` only turns echo off — so the two banner lines
   * ("Microsoft Windows [Version ...]" and the copyright notice) landed in the
   * FIRST command's captured output. The model then read them as that command's
   * result: the version-from-package-json eval case ran `jq` and was handed the
   * Windows banner, so it never saw the version it was asked for.
   *
   * Rather than pattern-match the banner text, which is localized and varies by
   * build, prime the shell with a marker and drop everything up to it. The
   * timeout means a shell that never starts delays the first command instead of
   * hanging it forever.
   */
  private flushStartupBanner(proc: ChildProcess): Promise<void> {
    const marker = makeSentinel() + '_READY';
    return new Promise<void>((resolve) => {
      let settled = false;
      let seen = '';
      const finish = (): void => {
        if (settled) return;
        settled = true;
        proc.stdout?.off('data', onData);
        clearTimeout(timer);
        resolve();
      };
      const onData = (chunk: Buffer): void => {
        seen += chunk.toString();
        if (seen.includes(marker)) finish();
      };
      const timer = setTimeout(finish, 5_000);
      timer.unref?.();
      proc.stdout?.on('data', onData);
      proc.stdin?.write(`echo ${marker}\r\n`);
    });
  }

  /**
   * Execute a command in the persistent shell.
   * Output streams via options.onOutput as it arrives.
   * Returns the full result when the command completes.
   */
  async execute(command: string, options: ShellExecuteOptions = {}): Promise<ShellResult> {
    // Serialize commands — one at a time through the shell
    if (this.busy) {
      await new Promise<void>((resolve) => this.commandQueue.push(resolve));
    }
    this.busy = true;

    try {
      return await this.executeInternal(command, options);
    } finally {
      this.busy = false;
      const next = this.commandQueue.shift();
      if (next) next();
    }
  }

  private async executeInternal(command: string, options: ShellExecuteOptions): Promise<ShellResult> {
    const proc = this.ensureProcess();
    // Must complete before this command's listeners attach, or the banner it
    // is draining lands in this command's output instead.
    await this.ready;
    const { timeout = 120_000, onOutput: rawOnOutput, signal } = options;
    // Every consumer of streamed shell output in SideCar lands in the
    // webview via `postMessage({command: 'toolOutput', ...})`, where it
    // is inserted as DOM `textContent`. The webview has no ANSI renderer,
    // so raw escape sequences display as garbage (`^[[31m`), bloat the
    // tool-call detail pane, and flow into any consumer that re-uses
    // the stream (background agent capture, verbose logs). Strip at
    // source — one place, one guarantee — instead of threading stripAnsi
    // through every consumer.
    const onOutput = rawOnOutput ? (chunk: string) => rawOnOutput(stripAnsi(chunk)) : undefined;
    const sentinel = makeSentinel();

    return new Promise<ShellResult>((resolve) => {
      let output = '';
      let timedOut = false;
      let resolved = false;

      // A ring buffer that always holds the last ~30% of max output,
      // regardless of how long the stream runs. When the main `output`
      // buffer has to be truncated mid-stream, we assemble the final
      // head+tail form from the frozen head + this ring. Without the
      // ring, the "tail" portion came from `output.slice(-tailSize)`,
      // which progressively lost the *actual* tail on each successive
      // truncation because the old tail had already been dropped and
      // replaced by the marker text. For shell commands this matters
      // because errors and exit diagnostics tend to live in the final
      // chunks of output — exactly the bytes the old logic discarded.
      const tailMax = Math.floor(this.maxOutputSize * 0.3);
      // Larger tail window used when the command exits non-zero. For
      // failures the error diagnostics are almost always in the last
      // portion of output, so we drop the head-banner and spend the
      // full byte budget on recent bytes. 80% leaves room for the
      // truncation marker and a small breathing margin.
      const failureTailMax = Math.floor(this.maxOutputSize * 0.8);
      let tailRing = '';
      let failureTailRing = '';
      // Tracks raw output volume before any truncation, so the marker
      // can report accurate totals.
      let totalCharsSeen = 0;
      // True once we've had to drop bytes from the primary `output`
      // buffer. Reused at finish() to choose between the head+tail
      // assembly (zero exit) and the tail-preferred assembly (non-zero).
      let wasTruncated = false;

      const finish = (exitCode: number) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        // When the command failed AND we had to truncate, reassemble
        // from the failure-tail ring so the user sees the actual error
        // output instead of the head-banner. For zero-exit runs we
        // keep the head+tail balance — the user wants the start
        // context of a long successful run (compile header, test
        // summary) AND the final bytes. Audit cycle-2 MEDIUM #15.
        let stdout = output;
        if (wasTruncated && exitCode !== 0) {
          stdout =
            `... (command exited ${exitCode}; head dropped, showing last ${failureTailRing.length} of ${totalCharsSeen} chars) ...\n\n` +
            failureTailRing;
        }
        // Strip ANSI escape sequences from the final stdout too. The
        // streaming onOutput wrapper above already strips each chunk,
        // but `output` is the accumulated pre-wrap buffer (built from
        // raw `data` events), so the final blob still contains the
        // original escape sequences until we strip here.
        resolve({ stdout: stripAnsi(stdout), exitCode, timedOut });
      };

      // Timeout handler
      const timer = setTimeout(() => {
        timedOut = true;
        output += '\n\n⚠️ Command timed out after ' + timeout / 1000 + 's';
        finish(-1);
        // Kill the shell so its subprocess doesn't keep running.
        // Null this.proc immediately (before the SIGTERM 'exit' event fires)
        // so ensureProcess() spawns a fresh shell for the next queued command
        // rather than sending to the dying process.
        if (this.proc === proc) this.proc = null;
        try {
          proc.kill();
        } catch {
          /* process already gone */
        }
      }, timeout);

      // Abort signal handler
      const onAbort = () => {
        timedOut = true;
        output += '\n\n⚠️ Command aborted';
        finish(-1);
        if (this.proc === proc) this.proc = null;
        try {
          proc.kill();
        } catch {
          /* process already gone */
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (proc.stdout) proc.stdout.removeListener('data', onData);
        if (proc.stderr) proc.stderr.removeListener('data', onStderrData);
      };

      // Buffer for detecting sentinel split across chunks
      let buffer = '';

      const checkSentinel = (): boolean => {
        // Sentinel format: SENTINEL_EXITCODE_END
        const pattern = sentinel + '_';
        const idx = buffer.indexOf(pattern);
        if (idx === -1) return false;

        // Find the end marker
        const afterSentinel = buffer.slice(idx + pattern.length);
        const endIdx = afterSentinel.indexOf('_END');
        if (endIdx === -1) return false; // sentinel not fully received yet

        // Extract exit code
        const exitCodeStr = afterSentinel.slice(0, endIdx);
        const exitCode = parseInt(exitCodeStr, 10);

        // `preOutput` is the content of `buffer` BEFORE the sentinel mark.
        // buffer at this point holds the held-back 200-char trailing
        // window from prior chunks + everything in this chunk before the
        // sentinel — none of which has been moved to `output` yet (onData
        // deliberately holds back 200 chars so split-across-chunks
        // sentinels can be detected). Append to output — don't overwrite.
        // Previously this line was `output = preOutput`, which silently
        // discarded every byte from prior chunks for any command whose
        // output was longer than a single ~200-char buffer window. That
        // bug was latent because every existing test used short commands
        // that fit inside one buffer window.
        const preOutput = buffer.slice(0, idx).replace(/\n$/, '');
        if (preOutput.length > 0) {
          output += preOutput;
          totalCharsSeen += preOutput.length;
          tailRing = (tailRing + preOutput).slice(-tailMax);
          failureTailRing = (failureTailRing + preOutput).slice(-failureTailMax);
          onOutput?.(preOutput);
          // Re-apply the head+tail truncation if the final append pushed
          // us over the cap.
          if (output.length > this.maxOutputSize) {
            wasTruncated = true;
            const headSize = Math.floor(this.maxOutputSize * 0.5);
            output =
              output.slice(0, headSize) +
              '\n\n... (output truncated, ' +
              totalCharsSeen +
              ' chars total — middle dropped, head and most-recent tail preserved) ...\n\n' +
              tailRing;
          }
        }
        finish(isNaN(exitCode) ? 0 : exitCode);
        return true;
      };

      const onData = (data: Buffer) => {
        const text = data.toString();
        buffer += text;

        if (checkSentinel()) return;

        // Move safe buffer content to output (keep last 200 chars for sentinel detection)
        const safeLen = Math.max(0, buffer.length - 200);
        if (safeLen > 0) {
          const safe = buffer.slice(0, safeLen);
          output += safe;
          totalCharsSeen += safe.length;
          tailRing = (tailRing + safe).slice(-tailMax);
          failureTailRing = (failureTailRing + safe).slice(-failureTailMax);
          buffer = buffer.slice(safeLen);
          onOutput?.(safe);
        }

        // Enforce max output size — keep head + tail with a ring-buffer-
        // based tail that tracks the most-recent bytes independent of
        // how many times we've truncated. Head stays frozen (first ~50%
        // of max) so the command banner / initial progress info is
        // preserved; tail comes from the ring buffer so the latest
        // output is always represented, not whatever the previous
        // truncation happened to leave behind. If exit code ends up
        // non-zero, finish() will re-assemble from failureTailRing
        // instead — see audit cycle-2 MEDIUM #15.
        if (output.length > this.maxOutputSize) {
          wasTruncated = true;
          const headSize = Math.floor(this.maxOutputSize * 0.5);
          output =
            output.slice(0, headSize) +
            '\n\n... (output truncated, ' +
            totalCharsSeen +
            ' chars total — middle dropped, head and most-recent tail preserved) ...\n\n' +
            tailRing;
        }
      };

      const onStderrData = (data: Buffer) => {
        // Stderr goes through the 2>&1 redirect, but just in case
        // some output leaks to stderr directly, capture it
        const text = data.toString();
        buffer += text;
        if (!checkSentinel()) {
          onOutput?.(text);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onStderrData);

      // Write the command + sentinel echo to stdin.
      // Run the command directly (no subshell) so exports, cd, etc. persist.
      // Redirect stderr to stdout for unified output.
      //
      // On POSIX shells, prepend the hardening prefix (see
      // POSIX_HARDENING_PREFIX docs above) so alias / function pollution
      // from an earlier turn can't silently hijack this command. The
      // prefix runs in the same logical line as the user command so its
      // effect is scoped to this execute() call; subsequent commands run
      // the prefix again on the next invocation.
      // STDIN MUST NOT REACH THE COMMAND.
      //
      // Completion is detected by writing a sentinel `echo` as a SECOND LINE to
      // the shell's stdin. Any command that reads stdin swallows that line
      // instead of the shell executing it, and prints it — so `cat` returned
      // `echo "` as its output, and the exit code was then parsed out of the
      // echoed text rather than the command, reporting a confident 0 for a
      // command that never completed. `cat`, `python`, `npm init`, `git commit`
      // with no -m, `ssh`, any confirmation prompt: all corrupted their output
      // and fabricated a status.
      //
      // Redirecting the command's stdin from the null device fixes both halves
      // and is the right semantics anyway — run_command has no way to supply
      // input, so "immediate EOF" beats "block forever waiting for a human".
      //
      // Grouped rather than appended: `<cmd> < /dev/null` binds the redirect to
      // the LAST element of a pipeline, which would break `echo x | cat`.
      // Braces (not a subshell) so `cd` and `export` still persist across
      // calls. The newline before the closing brace — rather than `; }` — is
      // load-bearing: `{ sleep 1 & ; }` is a syntax error, and a trailing `#`
      // comment would swallow a semicolon.
      if (this.isWindows) {
        proc.stdin?.write(`(${command}) < NUL\r\necho ${sentinel}_%ERRORLEVEL%_END\r\n`);
      } else {
        const hardening = hardeningPrefixFor(this.shellPath);
        proc.stdin?.write(`${hardening}{ ${command}\n} < /dev/null 2>&1\necho "${sentinel}_$?_END"\n`);
      }
    });
  }

  private static readonly MAX_BG_COMMANDS = MAX_BACKGROUND_COMMANDS;

  /**
   * Start a command in the background. Returns an ID to check on it later.
   * Limited to MAX_BACKGROUND_COMMANDS concurrent processes to prevent resource exhaustion.
   */
  executeBackground(command: string): string {
    // Enforce concurrency limit
    if (this.backgroundCommands.size >= ShellSession.MAX_BG_COMMANDS) {
      // Clean up completed commands first
      for (const [id, entry] of this.backgroundCommands) {
        if (entry.done) {
          this.backgroundCommands.delete(id);
        }
      }
      // If still at limit after cleanup, reject
      if (this.backgroundCommands.size >= ShellSession.MAX_BG_COMMANDS) {
        throw new Error(
          `Background command limit reached (${ShellSession.MAX_BG_COMMANDS}). ` +
            'Check or wait for existing commands to finish.',
        );
      }
    }

    const id = randomBytes(4).toString('hex');
    let bgCmd = this.isWindows ? process.env.COMSPEC || 'cmd.exe' : this.shellPath;
    let bgArgs = this.isWindows ? ['/C', command] : ['-c', command];
    if (!this.isWindows && this.sandboxEnabled && isSeatbeltSupported()) {
      ({ cmd: bgCmd, args: bgArgs } = wrapWithSeatbelt(bgCmd, bgArgs, this.cwd));
    }
    const rawProc = spawn(bgCmd, bgArgs, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wrap in ManagedChildProcess for lifecycle tracking
    const proc = new ManagedChildProcess(rawProc, `bg-cmd:${id}`, getProcessRegistry());

    const entry: BackgroundCommand = { output: '', done: false, exitCode: null, proc };
    this.backgroundCommands.set(id, entry);

    const onData = (data: Buffer) => {
      entry.output += data.toString();
      if (entry.output.length > this.maxOutputSize) {
        const keep = Math.floor(this.maxOutputSize * 0.8);
        entry.output = entry.output.slice(-keep);
      }
    };

    const underlying = proc.getProc();
    underlying.stdout?.on('data', onData);
    underlying.stderr?.on('data', onData);

    underlying.on('exit', (code) => {
      entry.done = true;
      entry.exitCode = code;
      underlying.stdout?.removeListener('data', onData);
      underlying.stderr?.removeListener('data', onData);
    });

    return id;
  }

  /**
   * Check on a background command by ID.
   */
  checkBackground(id: string): { done: boolean; output: string; exitCode: number | null } | null {
    const entry = this.backgroundCommands.get(id);
    if (!entry) return null;
    if (entry.done) {
      this.backgroundCommands.delete(id);
    }
    return { done: entry.done, output: entry.output, exitCode: entry.exitCode };
  }

  /**
   * Dispose the shell session and all background processes.
   */
  dispose(): void {
    const killWithTimeout = (proc: ChildProcess | ManagedChildProcess) => {
      const rawProc = proc instanceof ManagedChildProcess ? proc.getProc() : proc;
      try {
        rawProc.kill('SIGTERM');
      } catch {
        return;
      }
      // Force-kill if still alive after 3 seconds
      const timer = setTimeout(() => {
        try {
          rawProc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, 3000);
      rawProc.once('exit', () => clearTimeout(timer));
    };

    if (this.proc) {
      killWithTimeout(this.proc);
      this.proc = null;
    }
    for (const [, entry] of this.backgroundCommands) {
      killWithTimeout(entry.proc);
    }
    this.backgroundCommands.clear();
    this.commandQueue = [];
    this.busy = false;
  }
}
