import { workspace, Disposable } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentLogger } from './logger.js';
import type { AuditLog } from './auditLog.js';

const execAsync = promisify(exec);

/** Maximum chars of hook stdout/stderr to preserve in the audit log. */
const MAX_HOOK_OUTPUT_CHARS = 2000;

export interface EventHookConfig {
  onSave?: string;
  onCreate?: string;
  onDelete?: string;
}

/**
 * Lazy accessor so EventHookManager can fetch the *current* session's
 * audit log each time a hook fires — the audit log is session-scoped
 * and lives on ChatState, which may be recreated, so a captured
 * reference at construction time would go stale.
 */
export type AuditLogProvider = () => AuditLog | null;

export class EventHookManager implements Disposable {
  private disposables: Disposable[] = [];

  constructor(
    private logger?: AgentLogger,
    private getAuditLog?: AuditLogProvider,
  ) {}

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
    const sanitizedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(extraEnv)) {
      sanitizedEnv[key] = this.sanitizeEnvValue(value);
    }
    const env = { ...process.env, ...sanitizedEnv, SIDECAR_EVENT: event } as Record<string, string>;

    const startMs = Date.now();
    let stdout = '';
    let stderr = '';
    let isError = false;
    let errorMessage: string | undefined;

    try {
      const result = await execAsync(command, { cwd, timeout: 15_000, env });
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
      this.logger?.debug(`Event hook ${event} completed: ${command}`);
    } catch (err) {
      isError = true;
      errorMessage = err instanceof Error ? err.message : String(err);
      // execAsync attaches stdout/stderr to the error object on non-zero exit
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      this.logger?.warn(`Event hook ${event} failed: ${errorMessage}`);
    }

    // Persist hook output to the audit log so a prompt-injected or
    // misbehaving hook leaves a trail. Cycle-2 audit: previously only
    // runHook *errors* were logged (and only to the console logger,
    // not to the structured audit JSONL), making it impossible to
    // reconstruct what a hook actually did after the fact.
    const audit = this.getAuditLog?.();
    if (audit) {
      const durationMs = Date.now() - startMs;
      const truncate = (s: string) =>
        s.length > MAX_HOOK_OUTPUT_CHARS ? s.slice(0, MAX_HOOK_OUTPUT_CHARS) + '\n... (truncated)' : s;
      const summary =
        `$ ${command}\n` +
        `[cwd: ${cwd}]\n` +
        `[env overrides: ${Object.keys(sanitizedEnv).join(', ') || '(none)'}]\n` +
        (stdout ? `\n--- stdout ---\n${truncate(stdout)}\n` : '') +
        (stderr ? `\n--- stderr ---\n${truncate(stderr)}\n` : '') +
        (errorMessage ? `\n--- error ---\n${errorMessage}\n` : '');
      try {
        // Synthesize a tool-call-style audit entry for the hook. Using a
        // distinct `event_hook:<event>` name keeps it filterable from
        // real tool calls in the /audit UI.
        await audit.recordToolResult(`event_hook:${event}`, `hook-${startMs}`, summary, isError, durationMs);
      } catch (err) {
        this.logger?.warn(`Failed to audit-log event hook: ${err instanceof Error ? err.message : String(err)}`);
      }
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
