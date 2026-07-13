/**
 * Approval-mode and tool-permission resolution.
 *
 * Extracted from executor.ts so the policy logic is independently
 * testable and the orchestrator stays thin. Two callers:
 *   1. `executeTool` — the live dispatch path
 *   2. Tests — verifying every permission × mode × irrecoverable combo
 *      without spinning up the full executor harness.
 */

export type ApprovalMode = 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review';

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
  approvalMode: ApprovalMode;
  /** Resolved from modeToolPermissions → toolPermissions, post-trust-check. */
  explicitPermission: 'allow' | 'deny' | 'ask' | undefined;
  /** True when detectIrrecoverable returned a non-null description. */
  isIrrecoverable: boolean;
}

/**
 * Decide whether the current tool call needs a user confirmation step.
 *
 * Priority order (highest wins):
 *  1. `alwaysRequireApproval` — non-negotiable; overrides everything
 *  2. `isIrrecoverable` — force approval even in autonomous mode
 *  3. `explicitPermission: 'allow'` — user opted in; skip approval
 *  4. `explicitPermission: 'ask'`  — user opted in to always-ask
 *  5. Fall back to approvalMode × tool.requiresApproval
 */
export function resolveApprovalNeeded(opts: ResolveApprovalOptions): boolean {
  const { tool, approvalMode, explicitPermission, isIrrecoverable } = opts;
  if (tool.alwaysRequireApproval) return true;
  if (isIrrecoverable) return true;
  if (explicitPermission === 'allow') return false;
  if (explicitPermission === 'ask') return true;
  return approvalMode === 'manual' || (approvalMode === 'cautious' && !!tool.requiresApproval);
}
