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
  if (toolName === 'edit_file') return checkEditBudget(state, opts);
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
 * How many failed edit_file calls a run may make, as a multiple of its edit
 * budget. Failed edits do not spend the budget (see checkEditBudget), so this
 * is what still stops a run that only ever resubmits a broken edit.
 */
export const FAILED_EDIT_FACTOR = 2;

/**
 * edit_file's budget counts edits that APPLIED (#268). Counting every call let
 * failures spend it: in tight-budget SWE runs (gemma4:e4b, budget 6) that hit
 * it, about 5 of the 6 counted calls had changed nothing, mostly
 * search === replace no-ops, and 11 of 30 such runs had applied no edit at all.
 * Those runs kept calling edit_file because their change had not landed, and
 * the refusal told them their edits were "applied and kept". Failed calls get
 * their own, larger cap.
 */
function checkEditBudget(state: LoopState, opts: { canAskUser?: boolean }): string | null {
  const applied = state.toolCallCounts.get('edit_file') ?? 0;
  const failed = state.failedEditCalls ?? 0;
  const budget = toolBudgetFor(state, 'edit_file');
  const failedCap = budget * FAILED_EDIT_FACTOR;
  if (applied < budget && failed < failedCap) return null;

  recordDecision(
    state.logger,
    { kind: 'tool_budget', action: 'refused', tool: 'edit_file', count: applied + failed, budget },
    `Tool budget refused edit_file (${applied} applied/${budget}, ${failed} failed/${failedCap})`,
    'warn',
  );
  const why =
    applied >= budget
      ? `edit_file has applied ${applied} edits this session (budget: ${budget}).`
      : `${failed} edit_file calls this session failed and changed nothing (limit: ${failedCap}).`;
  const kept =
    applied === 0
      ? 'None of your edits applied, so the file is unchanged.'
      : `The ${applied} edit${applied === 1 ? '' : 's'} that applied ${applied === 1 ? 'is' : 'are'} kept.`;
  const next = opts.canAskUser
    ? `If you need more edits, explain why to the user via ask_user.`
    : `No more edit_file calls will run in this session, and no one is available to raise the limit.`;
  return `${why} ${kept} ${next}`;
}

/**
 * Increment the call counter for `toolName`. Call this after the tool
 * has actually been dispatched (success or error both count — we want to
 * limit total invocations, not just successful ones, to prevent retry
 * floods). NOT called for budget-exceeded or pre-execution aborts.
 * The exception is a FAILED edit_file call: it counts toward
 * `failedEditCalls`, not edit_file's budget (checkEditBudget).
 */
export function recordToolUse(state: LoopState, toolName: string, outcome: { failed?: boolean } = {}): void {
  if (toolName === 'edit_file' && outcome.failed) {
    state.failedEditCalls = (state.failedEditCalls ?? 0) + 1;
    return;
  }
  const count = state.toolCallCounts.get(toolName) ?? 0;
  state.toolCallCounts.set(toolName, count + 1);
}
