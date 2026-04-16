import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
// `import type` only — the actual runtime.ts module imports getRoot from
// here, so a value-level import would create a true cycle. Type-only
// imports are erased at compile time and are the canonical way to break
// cycles in TypeScript.
import type { ToolRuntime } from './runtime.js';
import type { SideCarClient } from '../../ollama/client.js';

// Re-exported so sibling tool modules can import ToolDefinition from a
// single shared entrypoint if they prefer.
export type { ToolDefinition };

// Cross-cutting types, path helpers, and validation/guard primitives shared
// by every tool category. No dependencies on runtime state — keeping this
// file side-effect-free means every tool module can import it without
// pulling in ShellSession, the symbol graph, or the default ToolRuntime.

/** Optional context passed to tool executors for streaming and cancellation. */
export type ClarifyFn = (question: string, options: string[], allowCustom?: boolean) => Promise<string | undefined>;

export interface ToolExecutorContext {
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  clarifyFn?: ClarifyFn;
  /** Per-tool permission overrides from the active custom mode. Merged with global toolPermissions (mode wins). */
  modeToolPermissions?: Record<string, 'allow' | 'deny' | 'ask'>;
  /**
   * Per-call ToolRuntime. When set, tools that need a persistent shell
   * session (run_command, run_tests) or workspace-scoped state (symbol
   * graph) resolve them from this runtime rather than the process-wide
   * `defaultRuntime` singleton. Used by BackgroundAgentManager so parallel
   * background agents don't trample each other's shell cwd/env/alias
   * state. Callers that don't pass a runtime fall through to the default.
   */
  toolRuntime?: ToolRuntime;
  /**
   * The active SideCarClient for this agent turn. When present, tools that
   * generate git trailers (git_commit) can call `client.buildModelTrailers()`
   * to embed which models contributed to the session.
   */
  client?: SideCarClient;
}

export interface ToolExecutor {
  (input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
  requiresApproval: boolean;
  /**
   * When true, approval is required on every call regardless of approval
   * mode or per-tool `toolPermissions` overrides. Reserved for tools that
   * change SideCar's own runtime state (backend profile, user settings) —
   * the user's durable configuration must not change without an explicit
   * click, even if the agent is running in autonomous mode or the user
   * previously auto-allowed the tool.
   */
  alwaysRequireApproval?: boolean;
}

export function getRoot(): string {
  return workspace.workspaceFolders?.[0]?.uri.fsPath || '';
}

export function getRootUri(): Uri {
  const folder = workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder open. Open a folder or workspace first.');
  }
  return folder.uri;
}

/** Reject obviously invalid file paths that indicate the model hallucinated. */
export function validateFilePath(filePath: string): string | null {
  if (!filePath || filePath.trim().length === 0) {
    return 'Error: file path is empty.';
  }
  // Reject paths with backticks, control chars, or that look like prose
  if (/[`\x00-\x1f]/.test(filePath)) {
    return `Error: invalid characters in file path: ${filePath.slice(0, 80)}`;
  }
  // Reject paths containing spaces that are clearly not file names
  // (e.g., "... ```) that contain diagram content")
  if (filePath.length > 80) {
    return `Error: file path too long (${filePath.length} chars): ${filePath.slice(0, 80)}...`;
  }
  // Reject paths that don't have at least one valid-looking segment
  const segments = filePath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg.length > 60) {
      return `Error: path segment too long, likely not a real file name: ${seg.slice(0, 60)}...`;
    }
  }
  // Block path traversal outside workspace
  if (filePath.includes('..')) {
    return `Error: path traversal ("..") is not allowed: ${filePath}`;
  }
  if (path.isAbsolute(filePath)) {
    return `Error: absolute paths are not allowed. Use a path relative to the workspace root.`;
  }
  return null; // valid
}

export const SENSITIVE_PATTERNS = [
  /^\.env($|\.)/i, // .env, .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
  /credentials\.json$/i,
  /secrets?\.(json|ya?ml|toml)$/i,
  /\.secret$/i,
  /token\.json$/i,
  /service.account\.json$/i,
];

/**
 * Paths under these prefixes are SideCar's own internal state. Writes
 * to them are rejected so a prompt-injected agent can't erase the
 * audit log, poison persistent memories, or corrupt the cache. Reads
 * are still allowed — the agent can legitimately consult its own
 * memory or audit trail.
 *
 * Human-editable areas (SIDECAR.md, plans/, specs/, scratchpad/) are
 * intentionally NOT listed — those are normal working files.
 */
export const PROTECTED_WRITE_PREFIXES = [
  '.sidecar/logs/', // repudiation: audit log must not be erasable
  '.sidecar/memory/', // poisoning: persistent memories must not be forgeable
  '.sidecar/sessions/', // tampering: session history must not be rewritable
  '.sidecar/cache/', // corruption: cache invariants would break
];

export function isSensitiveFile(filePath: string): boolean {
  const basename = filePath.split(/[\\/]/).pop() || '';
  return SENSITIVE_PATTERNS.some((p) => p.test(basename));
}

/**
 * Check whether a write to the given path should be rejected because
 * it targets SideCar's protected internal state. Returns an error
 * message if blocked, or null if the write is allowed.
 *
 * Paths are normalised to use forward slashes so the same prefix
 * check works for Windows-style input.
 */
export function isProtectedWritePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized === '.sidecar/settings.json') {
    return `Refusing to write SideCar's own settings file (${filePath}). Ask the user to edit it directly.`;
  }
  for (const prefix of PROTECTED_WRITE_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.startsWith('./' + prefix)) {
      return (
        `Refusing to write under ${prefix} — this path is SideCar's internal state ` +
        `(audit log, persistent memory, session history, or cache) and must not be modified by the agent. ` +
        `If you need to reset this state, ask the user to do it directly.`
      );
    }
  }
  return null;
}

/**
 * POSIX-shell-safe single-quoting. Any `'` in the input is escaped as
 * `'\''` which ends the current quoted string, emits a literal quote,
 * and opens a new quoted string. Safe even for paths containing
 * metacharacters like `$`, `` ` ``, `;`, `&`, `|`, space, newline.
 *
 * Used by `run_tests` to safely interpolate a model-supplied `file`
 * argument into a shell command. Note: on Windows, cmd.exe doesn't
 * interpret single quotes the same way. ShellSession uses bash on
 * non-Windows and cmd.exe on Windows; for the Windows case we additionally
 * reject metacharacters below instead of relying on quoting.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Reject paths that contain shell metacharacters — belt-and-suspenders on top of `validateFilePath`. */
export function hasShellMetachar(value: string): boolean {
  return /[\n\r;&|`$<>()!*?[\]{}"'\\]/.test(value);
}
