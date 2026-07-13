import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import type { SideCarConfig } from '../../config/settings.js';
// `import type` only — the actual runtime.ts module imports getRoot from
// here, so a value-level import would create a true cycle. Type-only
// imports are erased at compile time and are the canonical way to break
// cycles in TypeScript.
import type { ToolRuntime } from './runtime.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { EditTimelineStore } from '../editTimeline.js';
import type { MCPManager } from '../mcpManager.js';
import type { SidecarTestController } from '../../testing/testController.js';

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
  /**
   * Config snapshot injected from the agent loop's `state.config`. When
   * set, tool executors use this instead of calling the global `getConfig()`
   * — enabling unit tests to control tool behavior without stubbing the
   * module-level singleton. Falls back to `getConfig()` when absent so
   * tool executors invoked outside the loop (e.g. direct test calls) still
   * work without any wiring.
   */
  config?: SideCarConfig;
  clarifyFn?: ClarifyFn;
  /**
   * Optional command filter for run_command/run_tests. When set, the
   * tool rejects any command that doesn't pass this predicate BEFORE
   * execution. Used by the delegate_task local worker to restrict
   * commands to a safe read-only subset.
   */
  commandFilter?: (command: string) => boolean;
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
  /**
   * Working-directory override. When set, path-resolving tool calls resolve
   * relative paths against this directory instead of `workspace.workspaceFolders[0]`.
   * Used by ShadowWorkspace (and fork / facet dispatch) to route file and shell
   * operations into the shadow worktree at `.sidecar/shadows/<task-id>/` so the
   * main working tree stays pristine until the user accepts the task's diff.
   *
   * Honored by:
   *   - the fs tools (`read_file`, `write_file`, `edit_file`, `list_directory`)
   *     via `resolveRoot(context)` / `resolveRootUri(context)`
   *   - the git tools (`git_*`) via `new GitCLI(context.cwd)`
   *   - `grep` via `resolveRoot(context)`
   *   - `run_command` / `run_tests` / `profile_code` via the per-run
   *     `context.toolRuntime` (whose ShellSession is rooted at cwd); the shared
   *     VS Code terminal is bypassed while a cwd override is active because it
   *     can't be re-rooted per run.
   *
   * NOT honored (inherent VS Code-API limitations, so these still reflect the
   * main workspace): `search_files` (`workspace.findFiles` is workspace-scoped)
   * and `get_diagnostics` (`languages.getDiagnostics` reports on analyzed open
   * documents, not arbitrary shadow paths).
   *
   * Must be an absolute path.
   */
  cwd?: string;
  /**
   * Session-scoped edit timeline. When set, `write_file` and `edit_file`
   * record each real-disk write so the sidebar timeline view can show
   * what the agent changed and offer per-file revert. Omitted for
   * shadow-workspace and audit-mode writes (those have their own
   * accept/reject flows), and for background-agent runs that the user
   * didn't explicitly opt into tracking.
   */
  editTimeline?: EditTimelineStore;
  /**
   * Active MCPManager for this agent run. Passed so tools like
   * `delegate_to_mcp` can call specific MCP servers by name without
   * going through the global TOOL_REGISTRY lookup path.
   */
  mcpManager?: MCPManager;
  /**
   * VS Code TestController integration. When set, `run_tests` reports
   * its output here after execution so results appear in the native
   * Test Explorer panel without the user re-running manually.
   */
  testController?: SidecarTestController;
  /**
   * Files read via `read_file` during this agent iteration. Populated by
   * the readFile executor so editFile can detect when the model is editing
   * a file it hasn't seen yet and proactively inject the relevant section.
   * Reset at the start of each loop iteration via the LoopState wiring in
   * executeToolUses.ts. When absent (e.g. unit tests), the check is skipped.
   */
  filesReadThisTurn?: Set<string>;
  /**
   * Workspace index for the current session. When set, `write_file` and
   * `edit_file` call `invalidateFile` after each successful disk write so
   * the next `loadFileContent` call gets fresh content rather than the
   * stale pre-write cache entry.
   */
  workspaceIndex?: import('../../config/workspaceIndex.js').WorkspaceIndex;
  /**
   * Per-path set of content hashes written this run. When set, `write_file`
   * records each distinct write and soft-blocks a byte-identical re-write — a
   * no-op on disk and the signature of a model thrashing in a circle (write A →
   * write B → write A …). Threaded from `LoopState.writeHistoryByFile` so the
   * history persists across iterations. Absent in unit tests / non-loop calls,
   * where the check is simply skipped.
   */
  writeHistoryByFile?: Map<string, Set<string>>;
  /**
   * Per-path count of consecutive `write_file` calls with no intervening
   * verification of that file. `write_file` increments it and soft-blocks once
   * it exceeds the threshold (forcing the model to run/diagnose before rewriting
   * yet again); the loop resets a file's count when a verification exercises it.
   * Threaded from `LoopState.writesSinceVerifyByFile`; absent in unit tests /
   * non-loop calls, where the guard is skipped.
   */
  writesSinceVerifyByFile?: Map<string, number>;
  /**
   * Files the agent has successfully edited via `edit_file` this run. When set
   * and a path is present, `write_file` soft-blocks a full rewrite of that file
   * and tells the model to keep using `edit_file` — a regeneration would clobber
   * the targeted fixes. Threaded from `LoopState.filesEditedViaEditTool`; absent
   * in non-loop calls, where the guard is skipped.
   */
  filesEditedViaEditTool?: Set<string>;
  /**
   * Per-path signature of the most recent `edit_file` call that failed with
   * "search and replace text are identical" or "search string not found" —
   * both are unrecoverable-without-more-info failures where the tool can only
   * show a hint, not safely auto-apply a guess. A small/weak model frequently
   * resubmits the EXACT same failing call rather than adapting to the hint
   * (observed: gemma4:e4b repeating an identical search===replace call twice
   * before cycle detection bailed the run with zero edits ever landing).
   * `edit_file` checks this before erroring: if the incoming call's signature
   * matches what's stored for this path, the model is stuck in a loop, so the
   * error escalates to a blunt, explicit instruction instead of repeating the
   * same hint verbatim. Cleared on a successful edit to that path. Threaded
   * from `LoopState.editFailureSignatures`; absent in unit tests / non-loop
   * calls, where the escalation is simply skipped (every failure looks "first
   * time").
   */
  editFailureSignatures?: Map<string, string>;
  /**
   * Consecutive dispatch-bounce counts per (tool, kind) — schema errors,
   * malformed JSON, example replays, unknown tools. The executor escalates
   * its bounce message on repeats and clears a tool's counts when it
   * executes successfully. Threaded from `LoopState.bounceCounts`; absent
   * in unit tests / non-loop calls, where escalation is skipped.
   */
  bounceCounts?: Map<string, number>;
  /**
   * Whether the chat view is currently visible. Approval prompts escalate to
   * a native blocking modal only when it is NOT — an inline card the user
   * cannot see is no gate at all, but a modal per command when the chat is
   * open is pop-up spam. Absent (non-chat hosts) reads as "not visible", so
   * approvals keep their pre-v0.119 modal behavior there.
   */
  isChatVisible?: () => boolean;
  /**
   * Shared handle on the externalized plan (S1). The loop owns the ref and
   * re-injects `<plan_state>` each turn; `update_plan` mutates `ref.plan`.
   * Absent when `sidecar.plan.externalized` is off (the tool errors politely).
   */
  planRef?: { plan: import('../plans/externalPlan.js').ExternalPlan | null };
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

/**
 * Resolve the effective working-directory path for a tool call. When the
 * caller passes a `context.cwd` override (ShadowWorkspace uses this to
 * pin writes into the shadow worktree), use it; otherwise fall back to
 * the first workspace folder. All tools that read or write files should
 * use this helper instead of calling `getRoot()` / `getRootUri()` directly
 * so the shadow override is transparent to their existing logic.
 *
 * Returns an empty string when neither is available — consistent with
 * `getRoot()`'s existing behavior.
 */
export function resolveRoot(context?: ToolExecutorContext): string {
  return context?.cwd ?? getRoot();
}

/**
 * URI equivalent of `resolveRoot` for the `workspace.fs` APIs. Throws the
 * same way `getRootUri` does when no workspace folder is open and no
 * `context.cwd` was supplied.
 */
export function resolveRootUri(context?: ToolExecutorContext): Uri {
  if (context?.cwd) return Uri.file(context.cwd);
  return getRootUri();
}

/** Reject obviously invalid file paths that indicate the model hallucinated. */
export function validateFilePath(filePath: string): string | null {
  if (!filePath || filePath.trim().length === 0) {
    return 'file path is empty.';
  }
  // Reject paths with backticks, control chars, or that look like prose
  if (/[`\x00-\x1f]/.test(filePath)) {
    return `invalid characters in file path: ${filePath.slice(0, 80)}`;
  }
  // Reject paths containing spaces that are clearly not file names
  // (e.g., "... ```) that contain diagram content")
  if (filePath.length > 80) {
    return `file path too long (${filePath.length} chars): ${filePath.slice(0, 80)}...`;
  }
  // Reject paths that don't have at least one valid-looking segment
  const segments = filePath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg.length > 60) {
      return `path segment too long, likely not a real file name: ${seg.slice(0, 60)}...`;
    }
  }
  // Block path traversal outside workspace
  if (filePath.includes('..')) {
    return `path traversal ("..") is not allowed: ${filePath}`;
  }
  if (path.isAbsolute(filePath)) {
    return `absolute paths are not allowed. Use a path relative to the workspace root.`;
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

/** Normalize any thrown value into an error message string. */
export function formatToolError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
