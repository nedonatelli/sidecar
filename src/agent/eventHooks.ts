import { workspace, Disposable } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentLogger } from './logger.js';
import type { AuditLog } from './auditLog.js';

const execAsync = promisify(exec);

/** Maximum chars of hook stdout/stderr to preserve in the audit log. */
const MAX_HOOK_OUTPUT_CHARS = 2000;

/** Default timeout for hook execution (10 seconds). */
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** Maximum timeout allowed for hooks (60 seconds). */
const MAX_HOOK_TIMEOUT_MS = 60_000;

/**
 * Environment variables that are stripped from hook execution for security.
 * These could be used to hijack command execution or leak secrets.
 */
const STRIPPED_ENV_VARS = [
  // Credentials and secrets
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  // PATH manipulation risks
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  // Shell injection risks
  'BASH_ENV',
  'ENV',
  'CDPATH',
];

/**
 * Patterns that are not allowed in hook commands (security blocklist).
 * These could be used to exfiltrate data or execute arbitrary code.
 */
const BLOCKED_COMMAND_PATTERNS = [
  /curl\s+.*\|\s*(sh|bash|zsh)/i, // curl | sh/bash/zsh
  /wget\s+.*\|\s*(sh|bash|zsh)/i, // wget | sh/bash/zsh
  /\$\(curl/i, // $(curl ...)
  /`curl/i, // `curl ...`
  /eval\s+/i, // eval commands
  /\.\s+\/dev\/tcp/i, // bash /dev/tcp trick
  /nc\s+-e/i, // netcat reverse shell
  /base64\s+-d\s*\|\s*(sh|bash|zsh)/i, // base64 -d | sh/bash/zsh
];

export interface EventHookConfig {
  onSave?: string;
  onCreate?: string;
  onDelete?: string;
  /** Timeout in milliseconds for each hook (default: 10000, max: 60000). */
  timeout?: number;
}

/**
 * Validate a hook command against the security blocklist.
 * Returns an error message if the command is blocked, or null if it's allowed.
 */
export function validateHookCommand(command: string): string | null {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Hook command blocked by security policy: matches pattern ${pattern.source}`;
    }
  }
  return null;
}

/**
 * Create a sanitized environment for hook execution.
 * Strips sensitive variables and preserves PATH for command lookup.
 */
function createSandboxEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy process.env but filter out sensitive variables
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !STRIPPED_ENV_VARS.includes(key)) {
      env[key] = value;
    }
  }

  // Merge extra env vars (e.g., SIDECAR_FILE)
  for (const [key, value] of Object.entries(extraEnv)) {
    env[key] = value;
  }

  return env;
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
  private hookTimeout: number = DEFAULT_HOOK_TIMEOUT_MS;

  constructor(
    private logger?: AgentLogger,
    private getAuditLog?: AuditLogProvider,
  ) {}

  start(hooks: EventHookConfig): void {
    this.stop();
    const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    // Configure timeout (clamped to max)
    this.hookTimeout = Math.min(hooks.timeout ?? DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);

    if (hooks.onSave) {
      const cmd = hooks.onSave;
      // Validate command once at registration
      const validationError = validateHookCommand(cmd);
      if (validationError) {
        this.logger?.warn(`Skipping onSave hook: ${validationError}`);
      } else {
        this.disposables.push(
          workspace.onDidSaveTextDocument((doc) => {
            const relativePath = workspace.asRelativePath(doc.uri);
            this.runHook('onSave', cmd, cwd, { SIDECAR_FILE: relativePath });
          }),
        );
        this.logger?.info(`Event hook registered: onSave → ${cmd} (timeout: ${this.hookTimeout}ms)`);
      }
    }

    if (hooks.onCreate) {
      const cmd = hooks.onCreate;
      // Validate command once at registration
      const validationError = validateHookCommand(cmd);
      if (validationError) {
        this.logger?.warn(`Skipping onCreate hook: ${validationError}`);
      } else {
        this.disposables.push(
          workspace.onDidCreateFiles((e) => {
            for (const file of e.files) {
              const relativePath = workspace.asRelativePath(file);
              this.runHook('onCreate', cmd, cwd, { SIDECAR_FILE: relativePath });
            }
          }),
        );
        this.logger?.info(`Event hook registered: onCreate → ${cmd} (timeout: ${this.hookTimeout}ms)`);
      }
    }

    if (hooks.onDelete) {
      const cmd = hooks.onDelete;
      // Validate command once at registration
      const validationError = validateHookCommand(cmd);
      if (validationError) {
        this.logger?.warn(`Skipping onDelete hook: ${validationError}`);
      } else {
        this.disposables.push(
          workspace.onDidDeleteFiles((e) => {
            for (const file of e.files) {
              const relativePath = workspace.asRelativePath(file);
              this.runHook('onDelete', cmd, cwd, { SIDECAR_FILE: relativePath });
            }
          }),
        );
        this.logger?.info(`Event hook registered: onDelete → ${cmd} (timeout: ${this.hookTimeout}ms)`);
      }
    }
  }

  /** Strip control characters from env var values to prevent injection. */
  private sanitizeEnvValue(value: string): string {
    // Remove null bytes, newlines, and other control characters (keep printable + tab + space)
    return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  private async runHook(event: string, command: string, cwd: string, extraEnv: Record<string, string>): Promise<void> {
    // Sanitize the extra env vars (SIDECAR_FILE, etc.)
    const sanitizedExtraEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(extraEnv)) {
      sanitizedExtraEnv[key] = this.sanitizeEnvValue(value);
    }

    // Create sandbox environment: strips sensitive vars, adds SIDECAR_* vars
    const env = createSandboxEnv({
      ...sanitizedExtraEnv,
      SIDECAR_EVENT: event,
    });

    const startMs = Date.now();
    let stdout = '';
    let stderr = '';
    let isError = false;
    let errorMessage: string | undefined;

    try {
      const result = await execAsync(command, {
        cwd,
        timeout: this.hookTimeout,
        env,
        // Limit output buffer size to prevent memory exhaustion
        maxBuffer: 1024 * 1024, // 1MB
      });
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
      // Distinguish timeout from other errors
      if (errorMessage.includes('TIMEOUT') || errorMessage.includes('timed out')) {
        this.logger?.warn(`Event hook ${event} timed out after ${this.hookTimeout}ms: ${command}`);
      } else {
        this.logger?.warn(`Event hook ${event} failed: ${errorMessage}`);
      }
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
        `[env overrides: ${Object.keys(sanitizedExtraEnv).join(', ') || '(none)'}]\n` +
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
