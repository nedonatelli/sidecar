import { workspace } from 'vscode';
import type { PolicyHook, HookContext, HookResult } from '../loop/policyHook.js';
import type { LoopState } from '../loop/state.js';
import { ShellSession } from '../../terminal/shellSession.js';
import { matchGlob } from '../../config/structuredContextRules.js';
import { checkWorkspaceConfigTrust } from '../../config/workspaceTrust.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

/**
 * Shape of a single entry in `sidecar.regressionGuards`. Loaded from
 * workspace config, so every field has to be tolerant of absence or
 * malformed values — a bad setting entry should disable THAT guard,
 * not crash the loop.
 */
export interface RegressionGuardConfig {
  name: string;
  command: string;
  /** When the guard runs. `post-write` only fires when the turn
   *  included a file-mutation tool; `post-turn` fires after every
   *  turn; `pre-completion` fires when the model tries to finish. */
  trigger: 'post-write' | 'post-turn' | 'pre-completion';
  /** When `blocking: true` (default), a failing guard injects a
   *  synthetic user message so the agent must address it. With
   *  `blocking: false`, the loop just appends a warning and keeps
   *  going — advisory mode, e.g. perf-budget guards. */
  blocking?: boolean;
  /** Hard timeout for the command in ms. Default 30_000. */
  timeoutMs?: number;
  /** Optional glob list — guard only fires when the turn's touched
   *  files match. Empty/missing means "every turn (subject to trigger)". */
  scope?: string[];
  /** Bail out after this many consecutive failures for one guard on
   *  one task, to prevent runaway loops when the guard can't converge.
   *  Default 5. Counter resets on any success. */
  maxAttempts?: number;
  /** Optional override for the guard's working directory. Defaults to
   *  the workspace folder. Accepts `${workspaceFolder}` as a literal —
   *  left as-is since we already run in the workspace cwd by default. */
  workingDir?: string;
}

/** Tool names that contribute to the "post-write" trigger's "did this
 *  turn change files?" check. Same shape as the list in
 *  conversationSummarizer's `extractCodeChanges` so post-write fires
 *  on every mutation surface, not just write_file. */
const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'create_file',
  'rename_file',
  'move_file',
  'apply_edit',
  'apply_patch',
]);

/** Keys on a `tool_use` input record that commonly carry a file path. */
const PATH_KEYS = ['path', 'filePath', 'file_path', 'file', 'target', 'source'] as const;

function pathFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Collect paths that this turn's `tool_use` blocks mutated. Used by
 * both the "post-write" trigger filter (did any mutation happen?) and
 * the scope glob filter (did a mutation match the guard's scope?).
 */
function mutatedFiles(toolUses: ToolUseContentBlock[] | undefined): string[] {
  if (!toolUses) return [];
  const paths: string[] = [];
  for (const use of toolUses) {
    if (!MUTATION_TOOLS.has(use.name)) continue;
    const p = pathFromToolInput(use.input);
    if (p) paths.push(p);
  }
  return paths;
}

/**
 * Turn a guard-command result into the synthetic user-message body the
 * agent will see. Kept short and structured so the model has a clear
 * read on exit code, scope, and how to interpret the guard's complaint.
 */
function formatGuardFailure(guard: RegressionGuardConfig, exitCode: number, stdout: string): string {
  const header = `Regression guard \`${guard.name}\` failed with exit ${exitCode}.`;
  const body = stdout.trim() || '(no output)';
  return [
    header,
    '',
    `Command: \`${guard.command}\``,
    '',
    'Output:',
    '```',
    body.length > 4000 ? body.slice(0, 4000) + '\n... (truncated)' : body,
    '```',
    '',
    'Address the failure and re-run the command to verify before continuing.',
  ].join('\n');
}

/**
 * PolicyHook implementation for one configured regression guard.
 * One `RegressionGuardHook` instance per entry in
 * `sidecar.regressionGuards`; `buildRegressionGuardHooks()` below
 * wraps the config read + per-entry construction.
 *
 * Same lifecycle as the built-in auto-fix / stub / critic hooks:
 * registered on the `HookBus`, fires at its declared phase, pushes
 * a synthetic user message into `state.messages` on failure so the
 * loop continues to the next iteration to address the guard's
 * complaint.
 *
 * Attempt counter is instance-local (one per guard per task), so two
 * independent guards don't share a budget and re-invocations across
 * different tasks get a fresh count.
 */
export class RegressionGuardHook implements PolicyHook {
  readonly name: string;
  private readonly guard: RegressionGuardConfig;
  private attempts = 0;

  constructor(guard: RegressionGuardConfig) {
    this.guard = guard;
    this.name = `regressionGuard:${guard.name}`;
  }

  async afterToolResults(state: LoopState, ctx: HookContext): Promise<HookResult | void> {
    if (this.guard.trigger === 'pre-completion') return;
    return this.runGuard(state, ctx);
  }

  async onEmptyResponse(state: LoopState, ctx: HookContext): Promise<HookResult | void> {
    if (this.guard.trigger !== 'pre-completion') return;
    return this.runGuard(state, ctx);
  }

  private async runGuard(state: LoopState, ctx: HookContext): Promise<HookResult | void> {
    // Trigger + scope filtering.
    const touched = mutatedFiles(ctx.pendingToolUses);
    if (this.guard.trigger === 'post-write' && touched.length === 0) return;
    if (this.guard.scope && this.guard.scope.length > 0) {
      const anyInScope = touched.some((p) => this.guard.scope!.some((pat) => matchGlob(pat, p)));
      // pre-completion runs even without this turn touching files — the
      // final-gate use case cares about the overall state, not this
      // turn's specific writes.
      if (!anyInScope && this.guard.trigger !== 'pre-completion') return;
    }

    // Attempt budget.
    const maxAttempts = this.guard.maxAttempts ?? 5;
    if (this.attempts >= maxAttempts) {
      const already = state.messages[state.messages.length - 1];
      // Only emit the escalation message once, not on every subsequent turn.
      if (
        !already || typeof already.content === 'string'
          ? !(already?.content as string)?.includes(`${this.guard.name}\` exceeded`)
          : false
      ) {
        state.messages.push({
          role: 'user',
          content: `Regression guard \`${this.guard.name}\` exceeded ${maxAttempts} failed attempts — giving up and proceeding without it. Review the last guard output manually.`,
        });
        return { mutated: true, reason: `${this.name} budget exhausted` };
      }
      return;
    }

    // Execute.
    const cwd = this.guard.workingDir || workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return; // no workspace folder, nothing to gate against
    const timeout = this.guard.timeoutMs ?? 30_000;
    const session = new ShellSession(cwd);
    let exitCode: number;
    let stdout: string;
    try {
      const result = await session.execute(this.guard.command, { timeout });
      exitCode = result.exitCode;
      stdout = result.stdout;
    } catch (err) {
      // Command couldn't even spawn — treat as a non-blocking warning
      // (we can't infer user intent from a failed spawn) and move on.
      state.logger?.warn(
        `Regression guard '${this.guard.name}' failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    } finally {
      session.dispose();
    }

    // Success resets the attempt counter.
    if (exitCode === 0) {
      this.attempts = 0;
      return;
    }

    this.attempts += 1;

    // Advisory (non-blocking) guards never inject a failure as a user
    // turn — they just surface a warning callback and continue. The
    // loop behaves exactly as it would have without the guard.
    if (this.guard.blocking === false) {
      ctx.callbacks.onText?.(`\n[regression guard '${this.guard.name}' failed (advisory, exit ${exitCode})]\n`);
      return;
    }

    // Blocking: inject a synthetic user message so the agent must
    // address it on the next iteration.
    state.messages.push({
      role: 'user',
      content: formatGuardFailure(this.guard, exitCode, stdout),
    });
    return { mutated: true, reason: `${this.name} failed (attempt ${this.attempts})` };
  }
}

/**
 * Produce one `PolicyHook` per entry in `sidecar.regressionGuards`,
 * after a one-time workspace-trust prompt gates the whole set.
 *
 * Returns an empty list when:
 *   - The user hasn't configured any guards, or
 *   - The user has guards configured but blocks the trust prompt, or
 *   - `sidecar.regressionGuards.mode` is `"off"`.
 *
 * A failed trust prompt is equivalent to disabling all guards for the
 * session — same contract as `hooks`, `mcpServers`, `customTools`,
 * `scheduledTasks`, `toolPermissions`. Individual entries that fail
 * schema validation (missing name/command/trigger) are dropped with a
 * console warning rather than aborting the whole set.
 */
export async function buildRegressionGuardHooks(): Promise<PolicyHook[]> {
  const cfg = workspace.getConfiguration('sidecar');
  const mode = cfg.get<'off' | 'strict' | 'warn'>('regressionGuards.mode', 'strict');
  if (mode === 'off') return [];

  const raw = cfg.get<unknown[]>('regressionGuards', []);
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // Workspace-trust gate — same idiom as the other workspace-execution
  // surfaces. A new/hostile repo can't drop a `python /etc/backdoor.py`
  // into `sidecar.regressionGuards` and have it auto-fire.
  const trust = await checkWorkspaceConfigTrust(
    'regressionGuards',
    'SideCar: This workspace defines regression guards that execute shell commands after agent edits. Only trust these from repositories you control.',
  );
  if (trust === 'blocked') {
    console.log('[SideCar] Workspace regressionGuards blocked by user');
    return [];
  }

  const guards: PolicyHook[] = [];
  for (const entry of raw) {
    const guard = validateGuard(entry);
    if (!guard) continue;
    // In `warn` mode every guard is forced non-blocking regardless of
    // the per-entry setting, so the user can toggle off the blocking
    // behavior in one place during a known-broken refactor.
    if (mode === 'warn') guard.blocking = false;
    guards.push(new RegressionGuardHook(guard));
  }
  return guards;
}

/** Narrow an opaque config entry to a validated `RegressionGuardConfig`
 *  (or null if it's malformed). Exported for tests. */
export function validateGuard(entry: unknown): RegressionGuardConfig | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== 'string' || e.name.trim().length === 0) return null;
  if (typeof e.command !== 'string' || e.command.trim().length === 0) return null;
  if (e.trigger !== 'post-write' && e.trigger !== 'post-turn' && e.trigger !== 'pre-completion') return null;
  const guard: RegressionGuardConfig = {
    name: e.name,
    command: e.command,
    trigger: e.trigger,
  };
  if (typeof e.blocking === 'boolean') guard.blocking = e.blocking;
  if (typeof e.timeoutMs === 'number' && e.timeoutMs > 0) guard.timeoutMs = e.timeoutMs;
  if (Array.isArray(e.scope) && e.scope.every((s) => typeof s === 'string')) {
    guard.scope = e.scope as string[];
  }
  if (typeof e.maxAttempts === 'number' && e.maxAttempts > 0) guard.maxAttempts = e.maxAttempts;
  if (typeof e.workingDir === 'string') guard.workingDir = e.workingDir;
  return guard;
}
