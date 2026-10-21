/**
 * Per-tool rate limiting for the agent loop.
 *
 * Prevents a model from calling the same tool excessively in a single
 * session (e.g. 50 grep calls without acting on the results). The burst
 * cap in cycleDetection.ts catches per-iteration floods; this module
 * catches slow-burn exhaustion across the entire loop.
 */

import type { LoopState } from './state.js';

/**
 * Per-tool call budgets. Tools not listed here get DEFAULT_BUDGET.
 * These limits are per-session (one runAgentLoop invocation).
 */
const TOOL_BUDGETS: Record<string, number> = {
  grep: 15,
  search_files: 15,
  list_directory: 10,
  web_search: 5,
  read_file: 25,
  write_file: 20,
  edit_file: 20,
  run_command: 15,
  run_tests: 10,
  get_diagnostics: 10,
};

const DEFAULT_BUDGET = 20;

/** The base (medium-tier) budget for a tool, before the tier multiplier. */
export function baseToolBudget(toolName: string): number {
  return TOOL_BUDGETS[toolName] ?? DEFAULT_BUDGET;
}

/**
 * The budget for a tool in this run: the base budget times the scaffolding
 * profile's `toolBudgetMultiplier` (1 when no profile is resolved, i.e. the
 * historical behavior).
 */
export function toolBudgetFor(state: LoopState, toolName: string): number {
  const multiplier = state.scaffoldingProfile?.toolBudgetMultiplier ?? 1;
  return Math.round(baseToolBudget(toolName) * multiplier);
}

/**
 * Check whether a tool call should be allowed. Returns an error message
 * string when the budget is exhausted; returns null when the call is
 * allowed. Does NOT increment the counter — call `recordToolUse` after
 * the tool executes so denied, aborted, or pre-approval-gated calls
 * don't consume budget.
 *
 * `canAskUser` says whether anyone can answer `ask_user` (the run has a
 * clarification UI). Without one, the message used to send the model to
 * ask_user anyway: claude-haiku-4-5 on the SWE canary wrote "I've exhausted my
 * run_command budget (15 calls) and cannot execute the final test
 * verification" to a question nobody would answer (#236).
 */
export function checkToolBudget(
  state: LoopState,
  toolName: string,
  opts: { canAskUser?: boolean } = {},
): string | null {
  const count = state.toolCallCounts.get(toolName) ?? 0;
  const budget = toolBudgetFor(state, toolName);

  if (count >= budget) {
    const next = opts.canAskUser
      ? `Use a different approach or tool to make progress. If you need more calls to this tool, ` +
        `explain your reasoning to the user via ask_user.`
      : `No more calls to this tool will run in this session, and no one is available to raise the limit. ` +
        `Work with what you have already gathered, or use a different tool.`;
    return `Tool "${toolName}" has been called ${count} times this session (budget: ${budget}). ${next}`;
  }

  return null;
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
