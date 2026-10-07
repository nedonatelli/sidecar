import { window } from 'vscode';
import { resolveMode, type SideCarConfig } from '../../config/settings.js';
import type { ApprovalMode, ConfirmFn } from '../executor.js';

/**
 * Approval for a run inside a shadow worktree (a fork or a facet). The shadow
 * isolates file writes only: commands, git refs and remotes, databases and MCP
 * tools reach the user's real environment. So unless the user has chosen
 * autonomous mode, those ask first (`sandboxed`), while file edits stay free
 * for the review that follows the run.
 *
 * These runs have no chat card to ask through, so the default confirm is a
 * modal naming the run, with the full arguments in its detail.
 */
export function sandboxedRunApproval(
  config: Pick<SideCarConfig, 'agentMode' | 'customModes'>,
  label: string,
  confirmFn?: ConfirmFn,
): { approvalMode: ApprovalMode; confirmFn: ConfirmFn } {
  const mode = resolveMode(config.agentMode, config.customModes).approvalBehavior;
  return {
    approvalMode: mode === 'autonomous' ? 'autonomous' : 'sandboxed',
    confirmFn:
      confirmFn ??
      (async (message, actions, options) =>
        window.showWarningMessage(
          `SideCar (${label}): ${message.replace(/\*\*/g, '')}`,
          { modal: true, detail: options?.detail },
          ...actions,
        )),
  };
}
