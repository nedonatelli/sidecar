/**
 * Per-tool rate limiting for the agent loop.
 *
 * Prevents a model from calling the same tool excessively in a single
 * session (e.g. 50 grep calls without acting on the results). The burst
 * cap in cycleDetection.ts catches per-iteration floods; this module
 * catches slow-burn exhaustion across the entire loop.
 *
 * Budgets come from the scaffolding profile when one is resolved, so a strong
 * model is not held to caps sized for slow-burn floods on small local models.
 */

import type { LoopState } from './state.js';
import { TOOL_CALL_BUDGETS, DEFAULT_TOOL_CALL_BUDGET } from '../../config/constants.js';
import { recordDecision } from '../decisions.js';

function budgetFor(state: LoopState, toolName: string): number {
  return state.scaffoldingProfile?.toolBudgets[toolName] ?? TOOL_CALL_BUDGETS[toolName] ?? DEFAULT_TOOL_CALL_BUDGET;
}

/**
 * Check whether a tool call should be allowed. Returns an error message
 * string when the budget is exhausted; returns null when the call is
 * allowed. Does NOT increment the counter — call `recordToolUse` after
 * the tool executes so denied, aborted, or pre-approval-gated calls
 * don't consume budget.
 */
export function checkToolBudget(state: LoopState, toolName: string): string | null {
  const count = state.toolCallCounts.get(toolName) ?? 0;
  const budget = budgetFor(state, toolName);
  if (count < budget) return null;

  recordDecision(
    state.logger,
    { kind: 'tool_budget', action: 'refused', tool: toolName, count, budget },
    `Tool budget refused ${toolName} (${count}/${budget})`,
    'warn',
  );
  // In autonomous mode nobody answers ask_user: a model told to "explain via
  // ask_user" asked an empty room for permission to run its final verification
  // (SWE django-12856, 2026-10-20).
  const next =
    state.approvalMode === 'autonomous'
      ? `No one can grant more calls in autonomous mode. Work with the results you already have.`
      : `If you need more calls to this tool, explain your reasoning to the user via ask_user.`;
  return (
    `Tool "${toolName}" has been called ${count} times this session (budget: ${budget}). ` +
    `Use a different approach or tool to make progress. ${next}`
  );
}

/**
 * Increment the call counter for `toolName`. Call this after the tool
 * has actually been dispatched (success or error both count — we want to
 * limit total invocations, not just successful ones, to prevent retry
 * floods). NOT called for budget-exceeded or pre-execution aborts.
 */
export function recordToolUse(state: LoopState, toolName: string): void {
  const count = state.toolCallCounts.get(toolName) ?? 0;
  state.toolCallCounts.set(toolName, count + 1);
}
