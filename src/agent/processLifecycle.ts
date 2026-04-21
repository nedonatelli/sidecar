import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { Disposable } from 'vscode';

/**
 * Wraps a ChildProcess with a deterministic kill chain:
 * graceful/default → 2s → SIGTERM → 1s → SIGKILL.
 * Registers with ProcessRegistry on construction; unregisters on exit.
 */
export class ManagedChildProcess implements Disposable {
  readonly pid: number | undefined;
  private disposed = false;

  constructor(
    private proc: ChildProcess,
    private label: string,
    private registry: ProcessRegistry,
  ) {
    this.pid = proc.pid;
    registry.register(this);

    // Auto-unregister when process exits
    proc.once('exit', () => {
      registry.unregister(this);
    });
  }

  /** Get the underlying ChildProcess if raw access is needed. */
  getProc(): ChildProcess {
    return this.proc;
  }

  /**
   * Dispose with deterministic kill chain.
   * Graceful kill → 2s wait → SIGTERM → 1s wait → SIGKILL.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.registry.unregister(this);

    return new Promise<void>((resolve) => {
      const proc = this.proc;
      if (proc.exitCode !== null || proc.killed) {
        resolve();
        return;
      }

      const checkExit = () => {
        if (proc.exitCode !== null || proc.killed) {
          resolve();
          return true;
        }
        return false;
      };

      const exitHandler = () => {
        clearTimeout(timer);
        resolve();
      };
      proc.once('exit', exitHandler);

      // Stage 0: graceful kill (SIGTERM on Unix, TerminateProcess on Windows)
      proc.kill();

      let timer = setTimeout(() => {
        if (checkExit()) return;
        // Stage 1: explicit SIGTERM
        proc.kill('SIGTERM');
        timer = setTimeout(() => {
          if (checkExit()) return;
          // Stage 2: SIGKILL
          proc.kill('SIGKILL');
          // Hard deadline: 1s after SIGKILL
          timer = setTimeout(() => {
            proc.removeListener('exit', exitHandler);
            resolve();
          }, 1000);
        }, 1000);
      }, 2000);
    });
  }
}

interface PIDManifestEntry {
  pid: number;
  label: string;
  cmdline: string;
  spawnedAt: number;
}

interface PIDManifest {
  sessionId: string;
  pids: PIDManifestEntry[];
}

/**
 * Singleton registry for managed child processes.
 * Persists a manifest at `.sidecar/pids.json` so orphan processes from crashed
 * sessions can be swept on next activation.
 */
export class ProcessRegistry implements Disposable {
  private static _instance: ProcessRegistry | null = null;
  static getInstance(): ProcessRegistry {
    if (!ProcessRegistry._instance) {
      ProcessRegistry._instance = new ProcessRegistry();
    }
    return ProcessRegistry._instance;
  }

  private managed = new Map<number, ManagedChildProcess>();
  private manifestPath: string | null = null;
  private sessionId = Math.random().toString(36).substring(2, 9);

  setManifestPath(path: string): void {
    this.manifestPath = path;
  }

  register(mp: ManagedChildProcess): void {
    if (mp.pid === undefined) return;
    this.managed.set(mp.pid, mp);
    this.writeManifest().catch(() => {
      // Fire-and-forget; don't block on manifest write failure
    });
  }

  unregister(mp: ManagedChildProcess): void {
    if (mp.pid === undefined) return;
    this.managed.delete(mp.pid);
    this.writeManifest().catch(() => {
      // Fire-and-forget
    });
  }

  /** Sweep orphaned processes from the prior session. Called on extension activate. */
  async sweepOrphans(): Promise<void> {
    if (!this.manifestPath) return;

    let prior: PIDManifest | null = null;
    try {
      const bytes = await fs.promises.readFile(this.manifestPath, 'utf-8');
      prior = JSON.parse(bytes) as PIDManifest;
    } catch {
      // File doesn't exist or is invalid — no prior processes to sweep
      return;
    }

    for (const entry of prior.pids || []) {
      if (await this.isPidAlive(entry.pid, entry.cmdline)) {
        // Process still alive with matching cmdline — kill it to prevent orphans from crashes
        try {
          process.kill(entry.pid, 'SIGTERM');
          // Wait 1s for graceful exit
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (await this.isPidAlive(entry.pid)) {
            process.kill(entry.pid, 'SIGKILL');
          }
        } catch {
          // Process already dead or permission denied
        }
      }
    }
  }

  /** Check if a PID is alive and has the expected cmdline (guards against PID reuse). */
  private async isPidAlive(pid: number, expectedCmdline?: string): Promise<boolean> {
    try {
      // Lightweight check: sending signal 0 to a process checks if it's alive without sending a real signal
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.kill(pid, 0 as any); // Cast to bypass TypeScript check (0 is valid but typed as never)

      // If expectedCmdline is provided, verify the process hasn't been reused
      if (expectedCmdline) {
        const actualCmdline = await this.getProcessCmdline(pid);
        // Only consider it the same process if cmdline matches (allows partial match since ps/proc output varies)
        return actualCmdline.includes(expectedCmdline.split(' ')[0]); // Check if first token (command name) matches
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Get the cmdline of a process (platform-dependent). */
  private async getProcessCmdline(pid: number): Promise<string> {
    const platform = os.platform();
    try {
      if (platform === 'linux') {
        const cmdline = await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf-8');
        return cmdline.replace(/\0/g, ' ');
      } else if (platform === 'darwin') {
        // macOS: use 'ps' command
        const { execFile } = await import('child_process');
        const result = await new Promise<string>((resolve, reject) => {
          execFile('ps', ['-p', String(pid), '-o', 'args='], (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });
        return result.trim();
      }
    } catch {
      // On Windows or if the process is gone, return empty string
    }
    return '';
  }

  /** Write current manifest to disk (fire-and-forget, errors ignored). */
  private async writeManifest(): Promise<void> {
    if (!this.manifestPath) return;

    const entries: PIDManifestEntry[] = [];
    for (const mp of this.managed.values()) {
      if (mp.pid !== undefined) {
        entries.push({
          pid: mp.pid,
          label: `bg-command:${mp.pid}`,
          cmdline: 'node sidecar',
          spawnedAt: Date.now(),
        });
      }
    }

    const manifest: PIDManifest = {
      sessionId: this.sessionId,
      pids: entries,
    };

    await fs.promises.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /** Called by VS Code on extension deactivate via context.subscriptions. */
  async dispose(): Promise<void> {
    // Kill all managed processes gracefully
    const promises = Array.from(this.managed.values()).map((mp) => mp.dispose());
    await Promise.all(promises);

    // Write empty manifest for next session
    if (this.manifestPath) {
      const emptyManifest: PIDManifest = { sessionId: this.sessionId, pids: [] };
      await fs.promises.writeFile(this.manifestPath, JSON.stringify(emptyManifest, null, 2), 'utf-8');
    }
  }
}

/** Get the module-level singleton ProcessRegistry instance. */
export function getProcessRegistry(): ProcessRegistry {
  return ProcessRegistry.getInstance();
}
