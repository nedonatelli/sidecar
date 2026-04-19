/**
 * Approval-mode and tool-permission resolution (v0.69 chunk 1).
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
 * Tools whose approval prompts are escalated to a native VS Code modal
 * (`showWarningMessage` with `modal: true`) rather than an inline chat
 * card. Matches the user's mental model: "if it could break something,
 * block the editor until I decide." Write tools are not in this set
 * because they go through the diff-preview path, which is already a
 * native-feeling confirmation surface.
 */
export const NATIVE_MODAL_APPROVAL_TOOLS = new Set([
  'run_command',
  'run_tests',
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
