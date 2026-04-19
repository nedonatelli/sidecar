// ---------------------------------------------------------------------------
// Process Lifecycle Hardening (v0.70)
//
// Unified wrapper for child processes with deterministic cleanup:
//   - ManagedChildProcess: wraps ChildProcess with graceful close chain
//     (close → 2s → SIGTERM → 1s → SIGKILL)
//   - ProcessRegistry: singleton tracking all managed processes, pushed
//     into context.subscriptions for cleanup on extension deactivate
//   - Per-session PID manifest at .sidecar/pids.json for orphan detection
//   - Startup orphan sweep against prior session's manifest
//
// Every spawn site (MCP stdio, ShellSession, custom tools) should route
// through ManagedChildProcess to ensure deterministic cleanup.
// ---------------------------------------------------------------------------

import { type ChildProcess, spawn, execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Time to wait for graceful close before sending SIGTERM */
const GRACEFUL_CLOSE_TIMEOUT_MS = 2000;

/** Time to wait after SIGTERM before sending SIGKILL */
const SIGTERM_TIMEOUT_MS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManagedProcessInfo {
  /** Process ID */
  pid: number;
  /** Human-readable name for logging (e.g., "mcp:filesystem", "shell:agent") */
  name: string;
  /** Timestamp when the process was spawned */
  spawnedAt: number;
  /** Command that was spawned (for orphan detection) */
  command: string;
  /** Arguments passed to the command */
  args: string[];
}

export interface PidManifest {
  /** Session ID (random, regenerated each activation) */
  sessionId: string;
  /** Timestamp when the session started */
  startedAt: number;
  /** List of managed processes */
  processes: ManagedProcessInfo[];
}

export type ProcessState = 'running' | 'closing' | 'closed';

export interface ManagedChildProcessOptions {
  /** Human-readable name for logging */
  name: string;
  /** Command to spawn */
  command: string;
  /** Arguments */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables (merged with process.env) */
  env?: Record<string, string | undefined>;
  /** If true, don't register with ProcessRegistry (for testing) */
  skipRegistry?: boolean;
  /** Custom graceful close handler (e.g., send 'exit' command to shell) */
  gracefulClose?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// ManagedChildProcess
// ---------------------------------------------------------------------------

/**
 * Wrapper around ChildProcess with deterministic cleanup chain:
 * 1. Call gracefulClose() if provided (e.g., send 'exit' to shell)
 * 2. Wait GRACEFUL_CLOSE_TIMEOUT_MS for process to exit
 * 3. Send SIGTERM
 * 4. Wait SIGTERM_TIMEOUT_MS
 * 5. Send SIGKILL
 *
 * Emits 'exit' when the process terminates (regardless of how).
 */
export class ManagedChildProcess extends EventEmitter {
  private _proc: ChildProcess | null = null;
  private _state: ProcessState = 'closed';
  private _info: ManagedProcessInfo | null = null;
  private _gracefulClose?: () => Promise<void> | void;
  private _closePromise: Promise<void> | null = null;

  get proc(): ChildProcess | null {
    return this._proc;
  }

  get state(): ProcessState {
    return this._state;
  }

  get info(): ManagedProcessInfo | null {
    return this._info;
  }

  get pid(): number | undefined {
    return this._proc?.pid;
  }

  get isAlive(): boolean {
    return this._state === 'running' && this._proc !== null && !this._proc.killed;
  }

  /**
   * Spawn the child process.
   */
  spawn(options: ManagedChildProcessOptions): ChildProcess {
    if (this._state === 'running') {
      throw new Error(`ManagedChildProcess "${options.name}" is already running`);
    }

    const { name, command, args = [], cwd, env, skipRegistry, gracefulClose } = options;

    this._gracefulClose = gracefulClose;

    // Merge env with process.env, filtering out undefined values
    const mergedEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) {
          delete mergedEnv[key];
        } else {
          mergedEnv[key] = value;
        }
      }
    }

    this._proc = spawn(command, args, {
      cwd,
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detach on Windows to allow SIGTERM/SIGKILL to work
      detached: process.platform === 'win32',
    });

    if (!this._proc.pid) {
      throw new Error(`Failed to spawn process "${name}": no PID assigned`);
    }

    this._state = 'running';
    this._info = {
      pid: this._proc.pid,
      name,
      spawnedAt: Date.now(),
      command,
      args,
    };

    // Register with the global registry
    if (!skipRegistry) {
      ProcessRegistry.instance.register(this);
    }

    // Handle process exit
    this._proc.on('exit', (code, signal) => {
      this._state = 'closed';
      if (!skipRegistry) {
        ProcessRegistry.instance.unregister(this);
      }
      this.emit('exit', code, signal);
    });

    this._proc.on('error', (err) => {
      this.emit('error', err);
    });

    return this._proc;
  }

  /**
   * Close the process with the deterministic shutdown chain.
   * Returns a promise that resolves when the process is fully terminated.
   * Safe to call multiple times — subsequent calls return the same promise.
   */
  async close(): Promise<void> {
    // Already closing or closed
    if (this._closePromise) {
      return this._closePromise;
    }

    if (this._state === 'closed' || !this._proc) {
      return;
    }

    this._state = 'closing';
    this._closePromise = this._doClose();
    return this._closePromise;
  }

  private async _doClose(): Promise<void> {
    const proc = this._proc;
    if (!proc || proc.killed) {
      this._state = 'closed';
      return;
    }

    // Step 1: Try graceful close
    if (this._gracefulClose) {
      try {
        await Promise.resolve(this._gracefulClose());
      } catch {
        // Ignore errors in graceful close
      }
    }

    // Step 2: Wait for graceful exit
    const exitedGracefully = await this._waitForExit(GRACEFUL_CLOSE_TIMEOUT_MS);
    if (exitedGracefully) {
      this._state = 'closed';
      return;
    }

    // Step 3: Send SIGTERM
    try {
      if (process.platform === 'win32') {
        // Windows: use taskkill for process tree
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      // Process may already be dead
    }

    // Step 4: Wait for SIGTERM to take effect
    const exitedAfterTerm = await this._waitForExit(SIGTERM_TIMEOUT_MS);
    if (exitedAfterTerm) {
      this._state = 'closed';
      return;
    }

    // Step 5: Send SIGKILL
    try {
      if (process.platform !== 'win32') {
        proc.kill('SIGKILL');
      }
      // On Windows, taskkill /F already did the equivalent
    } catch {
      // Process may already be dead
    }

    // Final wait — should be immediate after SIGKILL
    await this._waitForExit(500);
    this._state = 'closed';
  }

  private _waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this._proc || this._proc.killed || this._state === 'closed') {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => {
        this._proc?.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      this._proc.once('exit', onExit);
    });
  }

  /**
   * Send a signal to the process (for advanced use cases).
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!this._proc || this._proc.killed) {
      return false;
    }
    return this._proc.kill(signal);
  }
}

// ---------------------------------------------------------------------------
// ProcessRegistry
// ---------------------------------------------------------------------------

/**
 * Singleton registry tracking all ManagedChildProcess instances.
 * Implements VS Code's Disposable interface for cleanup on deactivation.
 */
export class ProcessRegistry {
  private static _instance: ProcessRegistry | null = null;

  private _processes = new Map<number, ManagedChildProcess>();
  private _externalPids = new Map<number, ManagedProcessInfo>();
  private _sessionId: string;
  private _startedAt: number;
  private _manifestPath: string | null = null;
  private _disposed = false;

  private constructor() {
    this._sessionId = this._generateSessionId();
    this._startedAt = Date.now();
  }

  static get instance(): ProcessRegistry {
    if (!ProcessRegistry._instance) {
      ProcessRegistry._instance = new ProcessRegistry();
    }
    return ProcessRegistry._instance;
  }

  /**
   * Reset the singleton (for testing only).
   */
  static _reset(): void {
    ProcessRegistry._instance = null;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get processCount(): number {
    return this._processes.size;
  }

  /**
   * Initialize the registry with the workspace root.
   * Creates .sidecar directory if needed and performs orphan sweep.
   */
  async initialize(workspaceRoot: string): Promise<{ orphansKilled: number }> {
    const sidecarDir = path.join(workspaceRoot, '.sidecar');
    this._manifestPath = path.join(sidecarDir, 'pids.json');

    // Ensure .sidecar directory exists
    try {
      await fs.promises.mkdir(sidecarDir, { recursive: true });
    } catch {
      // May already exist
    }

    // Sweep orphans from prior session
    const orphansKilled = await this._sweepOrphans();

    // Write initial manifest
    await this._writeManifest();

    return { orphansKilled };
  }

  /**
   * Register a managed process.
   */
  register(proc: ManagedChildProcess): void {
    if (this._disposed) {
      return;
    }
    const pid = proc.pid;
    if (pid !== undefined) {
      this._processes.set(pid, proc);
      this._writeManifestSync();
    }
  }

  /**
   * Unregister a managed process (called on exit).
   */
  unregister(proc: ManagedChildProcess): void {
    const pid = proc.pid;
    if (pid !== undefined) {
      this._processes.delete(pid);
      if (!this._disposed) {
        this._writeManifestSync();
      }
    }
  }

  /**
   * Get all currently registered processes.
   */
  getAll(): ManagedChildProcess[] {
    return Array.from(this._processes.values());
  }

  /**
   * Get a process by PID.
   */
  get(pid: number): ManagedChildProcess | undefined {
    return this._processes.get(pid);
  }

  /**
   * Track an external PID (not managed by ManagedChildProcess).
   * Useful for processes spawned by third-party libraries (MCP SDK, etc.)
   * that we still want to track for orphan detection.
   */
  trackExternalPid(info: ManagedProcessInfo): void {
    if (this._disposed) {
      return;
    }
    // Store in manifest but not in _processes (we can't close it)
    this._externalPids.set(info.pid, info);
    this._writeManifestSync();
  }

  /**
   * Stop tracking an external PID.
   */
  untrackExternalPid(pid: number): void {
    this._externalPids.delete(pid);
    if (!this._disposed) {
      this._writeManifestSync();
    }
  }

  /**
   * Close all registered processes. Called on extension deactivation.
   */
  async dispose(): Promise<void> {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    const closePromises = Array.from(this._processes.values()).map((proc) =>
      proc.close().catch(() => {
        // Ignore close errors during disposal
      }),
    );

    await Promise.all(closePromises);
    this._processes.clear();

    // Clear the manifest
    if (this._manifestPath) {
      try {
        await fs.promises.unlink(this._manifestPath);
      } catch {
        // Ignore if already deleted
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async _sweepOrphans(): Promise<number> {
    if (!this._manifestPath) {
      return 0;
    }

    let manifest: PidManifest;
    try {
      const data = await fs.promises.readFile(this._manifestPath, 'utf-8');
      manifest = JSON.parse(data) as PidManifest;
    } catch {
      // No prior manifest or invalid JSON — nothing to sweep
      return 0;
    }

    // Don't sweep our own session
    if (manifest.sessionId === this._sessionId) {
      return 0;
    }

    let killed = 0;
    for (const info of manifest.processes) {
      if (this._isOrphan(info)) {
        try {
          process.kill(info.pid, 'SIGKILL');
          killed++;
        } catch {
          // Process may already be dead or we don't have permission
        }
      }
    }

    return killed;
  }

  /**
   * Check if a process from a prior session is an orphan.
   * A process is an orphan if:
   * 1. It's still running
   * 2. Its command line matches what we spawned (not a recycled PID)
   */
  private _isOrphan(info: ManagedProcessInfo): boolean {
    try {
      // Check if process exists (signal 0 doesn't kill, just checks)
      process.kill(info.pid, 0);

      // Process exists — verify it's actually our orphan by checking cmdline
      // This prevents killing unrelated processes that reused the PID
      if (process.platform === 'linux') {
        const cmdline = fs.readFileSync(`/proc/${info.pid}/cmdline`, 'utf-8');
        return cmdline.includes(info.command);
      } else if (process.platform === 'darwin') {
        const result = execSync(`ps -p ${info.pid} -o command=`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result.includes(info.command);
      }
      // On Windows, just trust the PID (taskkill is safer anyway)
      return true;
    } catch {
      // Process doesn't exist — not an orphan
      return false;
    }
  }

  private async _writeManifest(): Promise<void> {
    if (!this._manifestPath || this._disposed) {
      return;
    }

    const manifest: PidManifest = {
      sessionId: this._sessionId,
      startedAt: this._startedAt,
      processes: this._getProcessInfos(),
    };

    try {
      await fs.promises.writeFile(this._manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // Ignore write errors (read-only filesystem, etc.)
    }
  }

  private _writeManifestSync(): void {
    if (!this._manifestPath || this._disposed) {
      return;
    }

    const manifest: PidManifest = {
      sessionId: this._sessionId,
      startedAt: this._startedAt,
      processes: this._getProcessInfos(),
    };

    try {
      fs.writeFileSync(this._manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  private _getProcessInfos(): ManagedProcessInfo[] {
    const managed = Array.from(this._processes.values())
      .map((proc) => proc.info)
      .filter((info): info is ManagedProcessInfo => info !== null);
    const external = Array.from(this._externalPids.values());
    return [...managed, ...external];
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Get the workspace root, or undefined if no workspace is open.
 */
export function getWorkspaceRoot(): string | undefined {
  return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Convenience function to spawn a managed process.
 */
export function spawnManaged(options: ManagedChildProcessOptions): ManagedChildProcess {
  const managed = new ManagedChildProcess();
  managed.spawn(options);
  return managed;
}
