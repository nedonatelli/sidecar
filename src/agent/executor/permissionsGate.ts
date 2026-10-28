/**
 * Approval-mode and tool-permission resolution.
 *
 * Extracted from executor.ts so the policy logic is independently
 * testable and the orchestrator stays thin. Two callers:
 *   1. `executeTool` — the live dispatch path
 *   2. Tests — verifying every permission × mode × irrecoverable combo
 *      without spinning up the full executor harness.
 */

/**
 * `sandboxed` is for runs inside a shadow worktree (forks, facets): the file
 * tools write only to the shadow, which the user reviews afterwards, so they
 * run freely; any other tool that needs approval reaches the real environment
 * (commands, git refs and remotes, databases, MCP) and asks as in cautious.
 */
export type ApprovalMode = 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review' | 'sandboxed';

/** File tools whose writes stay inside a shadow worktree when one is active. */
export const SHADOW_CONTAINED_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

/**
 * Tools that go through the diff-preview flow when approval is needed.
 * Listed here (not in the approval gate) so both the gate and the diff
 * branch can import from one place.
 */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * Tools whose approval MAY be escalated to a native VS Code modal
 * (`showWarningMessage` with `modal: true`) instead of the inline chat card.
 *
 * Escalation is conditional, not automatic: the modal fires only when the
 * chat view is NOT visible, i.e. when an inline card would go unseen. With
 * the chat open — the normal agent-driving posture — these approve inline
 * (v0.119 dogfood: a run producing several commands threw a native pop-up per
 * call, each stealing editor focus, for operations that are not destructive).
 *
 * This is not the destructive-operation defence: `rm -rf`, `git push --force`,
 * `git reset --hard` and friends are caught by `detectIrrecoverable`, which
 * runs its own escalated type-to-CONFIRM gate in every mode regardless of
 * this set. Write tools are absent because they go through the diff-preview
 * path, which is already a visible confirmation surface.
 *
 * `run_tests` is deliberately NOT here — it runs the project's own test
 * command and cannot damage the tree.
 */
export const NATIVE_MODAL_APPROVAL_TOOLS = new Set([
  'run_command',
  'git_stage',
  'git_commit',
  'git_push',
  'git_pull',
  'git_branch',
  'git_stash',
]);

export interface ResolveApprovalOptions {
  /** Registered tool flags. */
  tool: { requiresApproval?: boolean; alwaysRequireApproval?: boolean };
  /** The tool's name, which the `sandboxed` mode needs. */
  toolName?: string;
  approvalMode: ApprovalMode;
  /** Resolved from modeToolPermissions → toolPermissions, post-trust-check. */
  explicitPermission: 'allow' | 'deny' | 'ask' | undefined;
  /** True when detectIrrecoverable returned a non-null description. */
  isIrrecoverable: boolean;
  /**
   * True when detectPackageInstall matched: the command installs a new
   * package, system software or a remote script. Whether to install anything
   * is the user's call in every mode. Optional for existing callers.
   */
  isPackageInstall?: boolean;
  /**
   * True when detectConfigEdit matched and the user's request names neither
   * the config file nor that kind of change (#169). Asked in every mode except
   * where the edit stays in a shadow worktree the user reviews afterwards.
   */
  isUnrequestedConfigEdit?: boolean;
}

/**
 * Decide whether the current tool call needs a user confirmation step.
 *
 * Priority order (highest wins):
 *  1. `alwaysRequireApproval` — non-negotiable; overrides everything
 *  2. `isIrrecoverable` — force approval even in autonomous mode
 *  3. `isPackageInstall` — installing software is the user's call, in every mode
 *  4. `isUnrequestedConfigEdit` — so is changing project config the request did
 *     not ask for, except a file write contained in a sandboxed shadow
 *  5. `explicitPermission: 'allow'` — user opted in; skip approval
 *  6. `explicitPermission: 'ask'`  — user opted in to always-ask
 *  7. Fall back to approvalMode × tool.requiresApproval (review asks like cautious)
 */
export function resolveApprovalNeeded(opts: ResolveApprovalOptions): boolean {
  const { tool, toolName, approvalMode, explicitPermission, isIrrecoverable } = opts;
  if (tool.alwaysRequireApproval) return true;
  if (isIrrecoverable) return true;
  if (opts.isPackageInstall) return true;
  // A sandboxed file write lands in the shadow, whose diff the user reviews
  // before anything reaches the project -- the same reason review mode queues
  // it unasked. A command (`npm init`) runs for real, so it still asks.
  if (opts.isUnrequestedConfigEdit && !(approvalMode === 'sandboxed' && SHADOW_CONTAINED_TOOLS.has(toolName ?? ''))) {
    return true;
  }
  if (explicitPermission === 'allow') return false;
  if (explicitPermission === 'ask') return true;
  if (approvalMode === 'sandboxed') return !!tool.requiresApproval && !SHADOW_CONTAINED_TOOLS.has(toolName ?? '');
  // Review mode queues file writes for review (the review handler intercepts
  // them before this gate); everything else it asks about like cautious mode.
  return (
    approvalMode === 'manual' || ((approvalMode === 'cautious' || approvalMode === 'review') && !!tool.requiresApproval)
  );
}
