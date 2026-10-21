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

/**
 * The budget for a tool in this run: the scaffolding profile's table when one
 * is resolved, else the historical (medium-tier) table.
 */
export function toolBudgetFor(state: LoopState, toolName: string): number {
  return state.scaffoldingProfile?.toolBudgets[toolName] ?? baseToolBudget(toolName);
}

/** The medium-tier budget for a tool: TOOL_CALL_BUDGETS, else DEFAULT_TOOL_CALL_BUDGET. */
export function baseToolBudget(toolName: string): number {
  return TOOL_CALL_BUDGETS[toolName] ?? DEFAULT_TOOL_CALL_BUDGET;
}

/**
 * Check whether a tool call should be allowed. Returns an error message
 * string when the budget is exhausted; returns null when the call is
 * allowed. Does NOT increment the counter — call `recordToolUse` after
 * the tool executes so denied, aborted, or pre-approval-gated calls
 * don't consume budget. A refusal is recorded as a `tool_budget` decision.
 *
 * `canAskUser` says whether anyone can answer `ask_user`: the run has a
 * clarification UI. Without one, the message used to send the model to
 * ask_user anyway, and claude-haiku-4-5 asked an empty room for permission to
 * run its final verification (SWE django-12856, 2026-10-20). This keys on the
 * UI, not the approval mode: in the extension's autonomous mode a person is
 * still at the chat panel to answer.
 */
export function checkToolBudget(
  state: LoopState,
  toolName: string,
  opts: { canAskUser?: boolean } = {},
): string | null {
  const count = state.toolCallCounts.get(toolName) ?? 0;
  const budget = toolBudgetFor(state, toolName);
  if (count < budget) return null;

  recordDecision(
    state.logger,
    { kind: 'tool_budget', action: 'refused', tool: toolName, count, budget },
    `Tool budget refused ${toolName} (${count}/${budget})`,
    'warn',
  );
  const next = opts.canAskUser
    ? `Use a different approach or tool to make progress. If you need more calls to this tool, ` +
      `explain your reasoning to the user via ask_user.`
    : `No more calls to this tool will run in this session, and no one is available to raise the limit. ` +
      `Work with what you have already gathered, or use a different tool.`;
  return `Tool "${toolName}" has been called ${count} times this session (budget: ${budget}). ${next}`;
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
