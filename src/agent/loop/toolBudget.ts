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
  const refusals = (state.toolBudgetRefusals ??= new Map<string, number>());
  const refusedBefore = refusals.get(toolName) ?? 0;
  refusals.set(toolName, refusedBefore + 1);
  if (refusedBefore > 0) return repeatRefusalMessage(state, toolName, budget, refusedBefore + 1, opts.canAskUser);
  const next = opts.canAskUser
    ? `Use a different approach or tool to make progress. If you need more calls to this tool, ` +
      `explain your reasoning to the user via ask_user.`
    : `No more calls to this tool will run in this session, and no one is available to raise the limit. ` +
      `Work with what you have already gathered, or use a different tool.`;
  return `Tool "${toolName}" has been called ${count} times this session (budget: ${budget}). ${next}`;
}

/**
 * What to use instead of a spent tool, most specific first (#268). Only tools
 * the run has and can still call are named.
 */
const ALTERNATIVES: Record<string, Array<[tool: string, use: string]>> = {
  run_command: [
    ['run_tests', 'run_tests for a test command'],
    ['read_file', 'read_file to look at a file'],
    ['grep', 'grep to search the code'],
  ],
  // No alternative for edit_file. "write_file with the complete new content"
  // was one, and in the #268 A/B (gemma4:e4b, edit_file budget 6) it made the
  // model rewrite whole 15-17 KB files four and five times; both tasks it did
  // that on broke dozens of previously-passing tests. A spent edit budget means
  // stop editing (EDIT_SPENT below).
  grep: [
    ['read_file', 'read_file on a path you have already found'],
    ['search_files', 'search_files to find files by name'],
  ],
  read_file: [['grep', 'grep for the specific symbol or line you need']],
  list_directory: [['search_files', 'search_files with a glob pattern']],
  search_files: [['list_directory', 'list_directory on the folder you need']],
};

/** The repeat refusal for edit_file: the edits are done; check them and finish, never rewrite around the limit. */
const EDIT_SPENT = (budget: number, refusal: number): string =>
  `Tool "edit_file" was refused again (refusal ${refusal}): its budget of ${budget} edits is spent, and every ` +
  `further edit is refused the same way. The edits you already made are applied and kept. Do not rewrite a ` +
  `file with write_file to get around this: a whole-file rewrite is how working code gets broken. Check what ` +
  `you have (read_file, or run the tests), then give your final answer.`;

/**
 * The refusal for a tool already refused this run. Over 7,734 SWE canary runs,
 * 78% of runs that hit a budget called the refused tool again, about five times
 * each: the first refusal's "use a different tool" did not register, and
 * repeating it word for word changed nothing (#268). This one names what to use
 * instead and when to stop.
 */
function repeatRefusalMessage(
  state: LoopState,
  toolName: string,
  budget: number,
  refusal: number,
  canAskUser: boolean | undefined,
): string {
  const available = state.tools ? new Set(state.tools.map((t) => t.name)) : null;
  const usable = (ALTERNATIVES[toolName] ?? []).filter(
    ([tool]) =>
      (available === null || available.has(tool)) && (state.toolCallCounts.get(tool) ?? 0) < toolBudgetFor(state, tool),
  );
  const instead = usable.length > 0 ? ` Instead, use ${usable.map(([, use]) => use).join('; or ')}.` : '';
  const ask = canAskUser ? ' If you truly need more calls to it, explain why to the user via ask_user.' : '';
  if (toolName === 'edit_file') return EDIT_SPENT(budget, refusal) + ask;
  return (
    `Tool "${toolName}" was refused again (refusal ${refusal}): its budget of ${budget} calls is spent, and ` +
    `every further call to it is refused the same way, so calling it again only uses up turns.${instead}${ask} ` +
    `If nothing else will move the task forward, stop calling tools and give your final answer from what ` +
    `you have already found.`
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
