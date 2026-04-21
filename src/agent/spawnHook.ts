import { spawn } from 'child_process';
import * as os from 'os';
import { ManagedChildProcess, getProcessRegistry } from './processLifecycle.js';

/**
 * Result of running a hook via spawn.
 */
export interface SpawnHookResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputTruncated: boolean;
}

/**
 * Options for runSpawnedHook.
 */
export interface RunSpawnedHookOptions {
  command: string;
  cwd?: string;
  env: Record<string, string>;
  label: string;
  maxOutputBytes?: number;
  initialTimeoutMs?: number;
  activityResetMs?: number;
  hardCapMs?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_INITIAL_TIMEOUT_MS = 15_000; // 15 seconds
const DEFAULT_ACTIVITY_RESET_MS = 5_000; // 5 seconds
const DEFAULT_HARD_CAP_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Run a shell command as a spawned process with bounded output, activity-adaptive timeout,
 * and automatic process lifecycle management.
 *
 * The timeout strategy:
 * - Initial budget: initialTimeoutMs (default 15s). If no output arrives, process is killed.
 * - Activity reset: Each stdout/stderr chunk resets the activity timer to activityResetMs (default 5s).
 * - Hard cap: After hardCapMs total elapsed time, process is killed regardless of activity.
 *
 * Output is bounded to maxOutputBytes. If exceeded, the middle is elided and a marker inserted.
 */
export async function runSpawnedHook(opts: RunSpawnedHookOptions): Promise<SpawnHookResult> {
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const initialTimeoutMs = opts.initialTimeoutMs ?? DEFAULT_INITIAL_TIMEOUT_MS;
  const activityResetMs = opts.activityResetMs ?? DEFAULT_ACTIVITY_RESET_MS;
  const hardCapMs = opts.hardCapMs ?? DEFAULT_HARD_CAP_MS;

  const shellCmd = os.platform() === 'win32' ? 'cmd.exe' : process.env.SHELL || '/bin/bash';
  const shellArg = os.platform() === 'win32' ? '/C' : '-c';

  const proc = spawn(shellCmd, [shellArg, opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const managed = new ManagedChildProcess(proc, opts.label, getProcessRegistry());

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let totalBytes = 0;
  let outputTruncated = false;
  let timedOut = false;

  // Track total elapsed time (hard cap)
  const hardCapTimer = setTimeout(() => {
    timedOut = true;
    managed.dispose().catch(() => {
      // Ignore dispose errors
    });
  }, hardCapMs);

  // Activity timer (resets on each data event)
  let activityTimer: NodeJS.Timeout | null = null;
  const resetActivityTimer = () => {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      timedOut = true;
      managed.dispose().catch(() => {
        // Ignore dispose errors
      });
    }, activityResetMs);
  };

  // Start with initial budget
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    timedOut = true;
    managed.dispose().catch(() => {
      // Ignore dispose errors
    });
  }, initialTimeoutMs);

  // Helper to append a chunk while respecting the byte limit
  const appendChunk = (chunks: string[], chunk: string): void => {
    const byteLength = Buffer.byteLength(chunk, 'utf-8');
    totalBytes += byteLength;

    if (totalBytes <= maxOutputBytes) {
      chunks.push(chunk);
    } else if (!outputTruncated) {
      // First overflow: mark truncation and keep trying to buffer more
      outputTruncated = true;
      chunks.push(chunk);
    } else {
      // Already truncated: drop this chunk to prevent unbounded memory growth
      // (the final assembly will handle elision)
    }
  };

  return new Promise<SpawnHookResult>((resolve) => {
    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(hardCapTimer);
      if (activityTimer) clearTimeout(activityTimer);

      let stdout = stdoutChunks.join('');
      let stderr = stderrChunks.join('');

      // Apply truncation if needed
      if (outputTruncated) {
        const combined = stdout + stderr;
        const maxPerSide = Math.floor(maxOutputBytes / 4); // Reserve space for both + elision marker
        if (combined.length > maxOutputBytes) {
          const head = combined.substring(0, maxPerSide);
          const tail = combined.substring(combined.length - maxPerSide);
          const elisionBytes = Buffer.byteLength(combined) - Buffer.byteLength(head) - Buffer.byteLength(tail);
          stdout = head + `\n[... ${elisionBytes} bytes elided]\n` + tail;
          stderr = '';
        }
      }

      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        outputTruncated,
      });
    };

    proc.on('exit', (code, signal) => {
      onExit(code, signal);
    });

    proc.on('error', (_err) => {
      onExit(null, null);
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      resetActivityTimer();
      appendChunk(stdoutChunks, chunk.toString('utf-8'));
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      resetActivityTimer();
      appendChunk(stderrChunks, chunk.toString('utf-8'));
    });
  });
}
