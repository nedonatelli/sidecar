import { workspace, Disposable } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentLogger } from './logger.js';

const execAsync = promisify(exec);

export interface EventHookConfig {
  onSave?: string;
  onCreate?: string;
  onDelete?: string;
}

export class EventHookManager implements Disposable {
  private disposables: Disposable[] = [];

  constructor(private logger?: AgentLogger) {}

  start(hooks: EventHookConfig): void {
    this.stop();
    const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    if (hooks.onSave) {
      const cmd = hooks.onSave;
      this.disposables.push(
        workspace.onDidSaveTextDocument((doc) => {
          const relativePath = workspace.asRelativePath(doc.uri);
          this.runHook('onSave', cmd, cwd, { SIDECAR_FILE: relativePath });
        }),
      );
      this.logger?.info(`Event hook registered: onSave → ${cmd}`);
    }

    if (hooks.onCreate) {
      const cmd = hooks.onCreate;
      this.disposables.push(
        workspace.onDidCreateFiles((e) => {
          for (const file of e.files) {
            const relativePath = workspace.asRelativePath(file);
            this.runHook('onCreate', cmd, cwd, { SIDECAR_FILE: relativePath });
          }
        }),
      );
      this.logger?.info(`Event hook registered: onCreate → ${cmd}`);
    }

    if (hooks.onDelete) {
      const cmd = hooks.onDelete;
      this.disposables.push(
        workspace.onDidDeleteFiles((e) => {
          for (const file of e.files) {
            const relativePath = workspace.asRelativePath(file);
            this.runHook('onDelete', cmd, cwd, { SIDECAR_FILE: relativePath });
          }
        }),
      );
      this.logger?.info(`Event hook registered: onDelete → ${cmd}`);
    }
  }

  /** Strip control characters from env var values to prevent injection. */
  private sanitizeEnvValue(value: string): string {
    // Remove null bytes, newlines, and other control characters (keep printable + tab + space)
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  private async runHook(event: string, command: string, cwd: string, extraEnv: Record<string, string>): Promise<void> {
    try {
      const sanitizedEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(extraEnv)) {
        sanitizedEnv[key] = this.sanitizeEnvValue(value);
      }
      const env = { ...process.env, ...sanitizedEnv, SIDECAR_EVENT: event } as Record<string, string>;
      await execAsync(command, { cwd, timeout: 15_000, env });
      this.logger?.debug(`Event hook ${event} completed: ${command}`);
    } catch (err) {
      this.logger?.warn(`Event hook ${event} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }

  dispose(): void {
    this.stop();
  }
}
