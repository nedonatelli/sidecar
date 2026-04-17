import { window } from 'vscode';
import { ShadowWorkspace } from './shadowWorkspace.js';
import { runAgentLoop, type AgentCallbacks, type AgentOptions } from '../loop.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { ChatMessage } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import { getRoot } from '../tools/shared.js';

/**
 * Result of a sandboxed agent-loop run. Indicates whether the run
 * happened directly against the main tree (`mode: 'direct'` when shadow
 * mode is off or no workspace is open) or inside a shadow worktree,
 * and — if sandboxed — whether the diff was ultimately applied.
 */
export interface SandboxResult {
  mode: 'direct' | 'shadow';
  /** True iff the run actually modified the user's main working tree. */
  applied: boolean;
  /** Human-readable reason when `applied` is false in shadow mode. */
  reason?: 'empty-diff' | 'rejected' | 'apply-failed';
  /** On shadow failure / rejection, the unified diff that was almost-applied. Useful for logging and debug surfaces. */
  rejectedDiff?: string;
  /** The shadow's task ID when mode is 'shadow'. Lets callers correlate logs with .sidecar/shadows/<id>/. */
  shadowId?: string;
}

/**
 * Run the agent loop inside a Shadow Workspace — an ephemeral git
 * worktree at `.sidecar/shadows/<task-id>/` — so the user's main
 * working tree stays pristine until they accept the resulting diff.
 *
 * Behavior by `sidecar.shadowWorkspace.mode`:
 *   - `off`    → delegates straight to `runAgentLoop` (main tree).
 *   - `opt-in` → delegates straight to `runAgentLoop`; callers opt a
 *                specific task into a shadow by calling this function
 *                explicitly with `forceShadow: true`. (Slash command
 *                wiring is follow-up work — for v0.59 MVP callers
 *                pass `forceShadow` directly.)
 *   - `always` → every invocation wraps in a shadow unconditionally.
 *
 * When sandboxed, every tool call carries `context.cwd = shadow.path`
 * via the `cwdOverride` option plumbed through the loop's
 * executor context, so fs-tool writes (`write_file`, `edit_file`, etc.)
 * land in the shadow. At run's end, if the shadow produced any diff,
 * the user is prompted via `window.showQuickPick` to accept or reject.
 * Accept → `shadow.applyToMain()` stages the patch onto main; reject
 * → the shadow is discarded and main is untouched.
 *
 * This is the v0.59 MVP. Per-hunk review UI, gate-command integration,
 * conflict-rebase handling, and symlinked build dirs ship in v0.60+.
 */
export async function runAgentLoopInSandbox(
  client: SideCarClient,
  messages: ChatMessage[],
  callbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {},
  sandboxOptions: { forceShadow?: boolean } = {},
): Promise<SandboxResult> {
  const cfg = getConfig();
  const shouldSandbox =
    cfg.shadowWorkspaceMode === 'always' ||
    (cfg.shadowWorkspaceMode === 'opt-in' && sandboxOptions.forceShadow === true);

  if (!shouldSandbox) {
    await runAgentLoop(client, messages, callbacks, signal, options);
    return { mode: 'direct', applied: true };
  }

  const mainRoot = getRoot();
  if (!mainRoot) {
    // No workspace folder open — the shadow has nothing to branch off of.
    // Fall through to direct execution and log the reason.
    callbacks.onText?.('\n[shadow mode skipped: no workspace folder is open. Agent writes will land directly.]\n');
    await runAgentLoop(client, messages, callbacks, signal, options);
    return { mode: 'direct', applied: true };
  }

  const shadow = new ShadowWorkspace({ mainRoot });
  try {
    await shadow.create();
    callbacks.onText?.(`\n[shadow workspace ${shadow.id} active at ${shadow.path}]\n`);

    await runAgentLoop(client, messages, callbacks, signal, {
      ...options,
      cwdOverride: shadow.path,
    });

    const diff = await shadow.diff();
    if (!diff) {
      callbacks.onText?.('\n[shadow task complete — no changes to apply]\n');
      return { mode: 'shadow', applied: false, reason: 'empty-diff', shadowId: shadow.id };
    }

    const lineCount = diff.split('\n').length;
    const fileCount = (diff.match(/^diff --git /gm) || []).length || (diff.match(/^--- /gm) || []).length;
    const accept = await window.showQuickPick(
      [
        {
          label: '$(check) Accept shadow changes',
          description: `Apply ${fileCount} file(s), ${lineCount} diff lines to main`,
          value: 'accept' as const,
        },
        {
          label: '$(close) Reject — keep main untouched',
          description: 'Discard the shadow; main tree is unchanged',
          value: 'reject' as const,
        },
      ],
      {
        placeHolder: `Shadow ${shadow.id}: review and choose`,
        title: 'Shadow Workspace Review',
        ignoreFocusOut: true,
      },
    );

    if (accept?.value === 'accept') {
      try {
        await shadow.applyToMain();
        callbacks.onText?.(`\n[shadow ${shadow.id} applied to main (${fileCount} files, ${lineCount} diff lines)]\n`);
        return { mode: 'shadow', applied: true, shadowId: shadow.id };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        callbacks.onText?.(`\n[shadow ${shadow.id} apply failed: ${msg}]\n`);
        return { mode: 'shadow', applied: false, reason: 'apply-failed', rejectedDiff: diff, shadowId: shadow.id };
      }
    }

    callbacks.onText?.(`\n[shadow ${shadow.id} rejected — main tree unchanged]\n`);
    return { mode: 'shadow', applied: false, reason: 'rejected', rejectedDiff: diff, shadowId: shadow.id };
  } finally {
    if (cfg.shadowWorkspaceAutoCleanup) {
      await shadow.dispose();
    } else {
      // Leave the worktree behind for post-mortem. The user gets a
      // note pointing at the path so they can inspect it, git-diff
      // it, or re-apply it manually.
      callbacks.onText?.(`\n[shadow preserved at ${shadow.path} (autoCleanup=false)]\n`);
    }
  }
}
