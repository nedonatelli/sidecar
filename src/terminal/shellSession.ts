import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as os from 'os';
import { MAX_BACKGROUND_COMMANDS } from '../config/constants.js';
import { stripAnsi } from './ansi.js';

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
  proc: ChildProcess;
}

// Generate a short alphanumeric sentinel (no special chars to worry about)
function makeSentinel(): string {
  return 'SIDECAR' + randomBytes(8).toString('hex').toUpperCase();
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
  private commandQueue: Array<() => void> = [];
  private backgroundCommands = new Map<string, BackgroundCommand>();
  private maxOutputSize: number;
  private isWindows: boolean;

  constructor(cwd: string, env?: Record<string, string>, maxOutputSize: number = 10 * 1024 * 1024) {
    this.cwd = cwd;
    this.env = { ...(process.env as Record<string, string>), ...env };
    this.maxOutputSize = maxOutputSize;
    this.isWindows = os.platform() === 'win32';
  }

  get isAlive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  private ensureProcess(): ChildProcess {
    if (this.isAlive && this.proc) return this.proc;

    const shellPath = this.isWindows ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash';

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

    this.proc = spawn(shellPath, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => {
      console.error('[ShellSession] Process error:', err.message);
      this.proc = null;
    });

    this.proc.on('exit', () => {
      this.proc = null;
    });

    return this.proc;
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
    const { timeout = 120_000, onOutput, signal } = options;
    const sentinel = makeSentinel();

    return new Promise<ShellResult>((resolve) => {
      let output = '';
      let timedOut = false;
      let resolved = false;

      const finish = (exitCode: number) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        // Strip ANSI escape sequences from the final stdout before
        // handing it to the caller. Raw escapes used to leak into the
        // agent's tool-result view and the audit log, where they bloat
        // token counts and corrupt downstream rendering. We keep the
        // streaming onOutput callback raw so live terminals still see
        // colors mid-execution — the strip only applies to the text
        // the caller receives after completion.
        resolve({ stdout: stripAnsi(output), exitCode, timedOut });
      };

      // Timeout handler
      const timer = setTimeout(() => {
        timedOut = true;
        output += '\n\n⚠️ Command timed out after ' + timeout / 1000 + 's';
        finish(-1);
      }, timeout);

      // Abort signal handler
      const onAbort = () => {
        timedOut = true;
        output += '\n\n⚠️ Command aborted';
        finish(-1);
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

        // Everything before the sentinel line is command output.
        const preOutput = buffer.slice(0, idx).replace(/\n$/, '');
        // Flush any buffered content to onOutput before finishing
        if (preOutput.length > output.length) {
          const remaining = preOutput.slice(output.length);
          if (remaining) onOutput?.(remaining);
        }
        output = preOutput;
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
          buffer = buffer.slice(safeLen);
          onOutput?.(safe);
        }

        // Enforce max output size — keep head + tail
        if (output.length > this.maxOutputSize) {
          const headSize = Math.floor(this.maxOutputSize * 0.7);
          const tailSize = Math.floor(this.maxOutputSize * 0.2);
          output =
            output.slice(0, headSize) +
            '\n\n... (output truncated, ' +
            output.length +
            ' chars total) ...\n\n' +
            output.slice(-tailSize);
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
      if (this.isWindows) {
        proc.stdin?.write(`${command}\r\necho ${sentinel}_%ERRORLEVEL%_END\r\n`);
      } else {
        proc.stdin?.write(`${command} 2>&1\necho "${sentinel}_$?_END"\n`);
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
    const proc = spawn(
      this.isWindows ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash',
      this.isWindows ? ['/C', command] : ['-c', command],
      { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const entry: BackgroundCommand = { output: '', done: false, exitCode: null, proc };
    this.backgroundCommands.set(id, entry);

    const onData = (data: Buffer) => {
      entry.output += data.toString();
      if (entry.output.length > this.maxOutputSize) {
        const keep = Math.floor(this.maxOutputSize * 0.8);
        entry.output = entry.output.slice(-keep);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('exit', (code) => {
      entry.done = true;
      entry.exitCode = code;
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
    const killWithTimeout = (proc: ChildProcess) => {
      try {
        proc.kill('SIGTERM');
      } catch {
        return;
      }
      // Force-kill if still alive after 3 seconds
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      }, 3000);
      proc.once('exit', () => clearTimeout(timer));
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
