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
import { TEST_RUNNER_RE } from '../completionGate/pathUtil.js';

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

/** Commands that only search, print or filter. `sed` only as `sed -n`; `find` is checked for -exec/-delete. */
const SHELL_SEARCH_RE = /^(grep|egrep|fgrep|rg|find|ls|cat|head|tail|wc|tree|awk|sed\s+-n|sort|uniq|cut)(\s|$)/;
/** Writes a file: a redirect other than to /dev/null or between streams, tee, find's -exec/-delete, sed -i. */
const SHELL_WRITE_RE = /(^|[^0-9&])>(?!\s*\/dev\/null|&)|\btee\b|\s-(exec|execdir|delete|ok)\b|\bsed\s+(-\w+\s+)*-i/;

/**
 * True when a shell command only searches or prints files: every segment
 * (split on `&&`, `||`, `;` and `|`) is a `cd` or one of the search commands,
 * at least one is a search, and nothing writes a file.
 */
export function isShellSearch(command: string): boolean {
  if (SHELL_WRITE_RE.test(command)) return false;
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segments.some((s) => SHELL_SEARCH_RE.test(s))) return false;
  return segments.every((s) => SHELL_SEARCH_RE.test(s) || /^cd(\s|$)/.test(s));
}

/**
 * The budget a call spends (#311): its own tool's, except a run_command that
 * only searches, which spends grep's. gemma4:31b searched through the shell:
 * on the SWE canary 21% of its runs spent all of run_command's budget, about
 * half of it on grep/find/cat, and 16% of runs ended with the last source edit
 * untested, because run_command is the only way to run a test there. Searches
 * now draw on the search budget, so tests keep run_command's.
 */
export function budgetKey(toolName: string, input: unknown): string {
  if (toolName !== 'run_command') return toolName;
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === 'string' && isShellSearch(command) ? 'grep' : toolName;
}

/** What checkToolBudget needs to know about the call and the run. */
export interface ToolBudgetCheckOptions {
  /** Anyone can answer ask_user: the run has a clarification UI (see checkToolBudget). */
  canAskUser?: boolean;
  /**
   * Whether the model is offered a tool this turn. A repeat refusal names an
   * alternative only when it is offered and its own budget is not spent, so it
   * never sends the model to a tool that cannot run. Absent, none is named.
   */
  isOffered?: (toolName: string) => boolean;
  /** The refused call's input: a test command sent through run_command is pointed at run_tests. */
  input?: unknown;
}

/**
 * How many failed edit_file calls a run may make, as a multiple of its edit
 * budget. Failed edits do not spend the budget (see isToolBudgetSpent), so this
 * is what still stops a run that only ever resubmits a broken edit.
 */
export const FAILED_EDIT_FACTOR = 2;

/**
 * True when every further call to `toolName` this run will be refused. Pure:
 * cycle detection asks it before dispatch, to recognise a turn whose calls will
 * all be refused (#268).
 *
 * edit_file's budget counts edits that APPLIED (#268). Counting every call let
 * failures spend it: in tight-budget SWE runs (gemma4:e4b, budget 6) that hit
 * it, about 5 of the 6 counted calls had changed nothing, mostly
 * search === replace no-ops, and 11 of 30 such runs had applied no edit at all.
 * Those runs kept calling edit_file because their change had not landed, and
 * the refusal told them their edits were "applied and kept". Failed calls get
 * their own, larger cap.
 */
export function isToolBudgetSpent(state: LoopState, toolName: string): boolean {
  const budget = toolBudgetFor(state, toolName);
  const count = state.toolCallCounts.get(toolName) ?? 0;
  if (toolName !== 'edit_file') return count >= budget;
  return count >= budget || (state.failedEditCalls ?? 0) >= budget * FAILED_EDIT_FACTOR;
}

/** How many times `toolName` has been refused for its budget this run. */
export function toolBudgetRefusals(state: LoopState, toolName: string): number {
  return state.toolBudgetRefusals?.get(toolName) ?? 0;
}

/**
 * Check whether a tool call should be allowed. Returns an error message
 * string when the budget is exhausted; returns null when the call is
 * allowed. Does NOT increment the counter — call `recordToolUse` after
 * the tool executes so denied, aborted, or pre-approval-gated calls
 * don't consume budget. A refusal is recorded as a `tool_budget` decision
 * and counted in `state.toolBudgetRefusals`.
 *
 * `canAskUser` says whether anyone can answer `ask_user`: the run has a
 * clarification UI. Without one, the message used to send the model to
 * ask_user anyway, and claude-haiku-4-5 asked an empty room for permission to
 * run its final verification (SWE django-12856, 2026-10-20). This keys on the
 * UI, not the approval mode: in the extension's autonomous mode a person is
 * still at the chat panel to answer.
 *
 * The second and later refusals of a tool get a different message (#268). Of
 * the 351 archived SWE canary runs that hit a budget, 274 (78%) called the
 * refused tool again, about 5 refusals per run, and rewording the one refusal
 * did not change that (272 of 349 repeated on the old wording). A repeat now
 * says outright that every further call will be refused, names the offered
 * tools that can stand in for this one, and otherwise says to finish.
 */
export function checkToolBudget(state: LoopState, toolName: string, opts: ToolBudgetCheckOptions = {}): string | null {
  if (!isToolBudgetSpent(state, toolName)) return null;
  const refusals = (state.toolBudgetRefusals ??= new Map<string, number>());
  const nth = (refusals.get(toolName) ?? 0) + 1;
  refusals.set(toolName, nth);

  const facts = toolName === 'edit_file' ? refuseEdit(state, nth) : refuseTool(state, toolName, nth);
  if (nth > 1) return `${facts} ${repeatRefusal(state, toolName, nth, opts)}`;
  if (toolName === 'edit_file') {
    const next = opts.canAskUser
      ? `If you need more edits, explain why to the user via ask_user.`
      : `No more edit_file calls will run in this session, and no one is available to raise the limit.`;
    return `${facts} ${next}`;
  }
  const next = opts.canAskUser
    ? `Use a different approach or tool to make progress. If you need more calls to this tool, ` +
      `explain your reasoning to the user via ask_user.`
    : `No more calls to this tool will run in this session, and no one is available to raise the limit. ` +
      `Work with what you have already gathered, or use a different tool.`;
  return `${facts} ${next}`;
}

/** Record a refusal of `toolName` and say why it was refused. */
function refuseTool(state: LoopState, toolName: string, nth: number): string {
  const count = state.toolCallCounts.get(toolName) ?? 0;
  const budget = toolBudgetFor(state, toolName);
  recordDecision(
    state.logger,
    { kind: 'tool_budget', action: 'refused', tool: toolName, count, budget },
    `Tool budget refused ${toolName} (${count}/${budget}, refusal ${nth})`,
    'warn',
  );
  return `Tool "${toolName}" has been called ${count} times this session (budget: ${budget}).`;
}

/** Record a refusal of edit_file and say why, and what became of the edits. */
function refuseEdit(state: LoopState, nth: number): string {
  const applied = state.toolCallCounts.get('edit_file') ?? 0;
  const failed = state.failedEditCalls ?? 0;
  const budget = toolBudgetFor(state, 'edit_file');
  const failedCap = budget * FAILED_EDIT_FACTOR;
  recordDecision(
    state.logger,
    { kind: 'tool_budget', action: 'refused', tool: 'edit_file', count: applied + failed, budget },
    `Tool budget refused edit_file (${applied} applied/${budget}, ${failed} failed/${failedCap}, refusal ${nth})`,
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
  return `${why} ${kept}`;
}

/**
 * The second and later refusal of a tool (#268): say that this call, like the
 * last, did not run and the next will not either, then give the model
 * somewhere to go: the offered tools that can do this tool's job, or finishing.
 */
function repeatRefusal(state: LoopState, toolName: string, nth: number, opts: ToolBudgetCheckOptions): string {
  const head =
    `This is refusal ${nth} of ${toolName} since its budget ran out: the call did not run, and every ` +
    `further ${toolName} call this session will be refused the same way.`;
  const alternatives = budgetAlternatives(state, toolName, opts);
  const ask = opts.canAskUser ? ` If you cannot finish without it, explain why to the user via ask_user.` : '';
  if (alternatives.length === 0) {
    return `${head} Stop calling ${toolName} and give your final answer from what you have already gathered.${ask}`;
  }
  return (
    `${head} Instead: ${alternatives.join('; ')}. If none of those does what you need, stop calling tools ` +
    `and give your final answer from what you have already gathered.${ask}`
  );
}

/**
 * Offered tools that can do some of `toolName`'s job, as instructions. Each is
 * named only when the model can call it and its own budget is not spent, so a
 * repeat refusal never points at a tool that would refuse too. edit_file is
 * never pointed at itself in a smaller form: any edit_file call is refused.
 */
function budgetAlternatives(state: LoopState, toolName: string, opts: ToolBudgetCheckOptions): string[] {
  const usable = (name: string) => opts.isOffered?.(name) === true && !isToolBudgetSpent(state, name);
  const out: string[] = [];
  switch (toolName) {
    case 'run_command': {
      const command = (opts.input as { command?: unknown } | undefined)?.command;
      if (typeof command === 'string' && TEST_RUNNER_RE.test(command)) {
        if (usable('run_tests')) out.push('run the tests with run_tests, which has its own budget');
        break;
      }
      const look = ['read_file', 'grep', 'list_directory'].filter(usable);
      if (look.length > 0) out.push(`to look at files, use ${look.join(' or ')} rather than a shell command`);
      break;
    }
    case 'edit_file':
      if (usable('write_file')) {
        // write_file refuses to overwrite a file edit_file has changed (the
        // enforce-edit guard in fs.ts), so say which files those are.
        const locked = [...(state.filesEditedViaEditTool ?? [])].slice(0, 5);
        out.push(
          'write the whole file with write_file, giving its complete new content, not a fragment' +
            (locked.length > 0
              ? ` (write_file refuses to overwrite a file you already changed with edit_file: ${locked.map((p) => `\`${p}\``).join(', ')})`
              : ''),
        );
      }
      break;
    case 'grep':
    case 'search_files':
    case 'list_directory':
      if (usable('read_file')) out.push('open a file your earlier results already named with read_file');
      if (toolName === 'list_directory' && usable('search_files')) out.push('find files by name with search_files');
      break;
    case 'read_file':
      if (usable('grep')) out.push('find the lines you need with grep, which shows matching lines with line numbers');
      break;
  }
  return out;
}

/**
 * Increment the call counter for `toolName`. Call this after the tool
 * has actually been dispatched (success or error both count — we want to
 * limit total invocations, not just successful ones, to prevent retry
 * floods). NOT called for budget-exceeded or pre-execution aborts.
 * The exception is a FAILED edit_file call: it counts toward
 * `failedEditCalls`, not edit_file's budget (isToolBudgetSpent).
 */
export function recordToolUse(state: LoopState, toolName: string, outcome: { failed?: boolean } = {}): void {
  if (toolName === 'edit_file' && outcome.failed) {
    state.failedEditCalls = (state.failedEditCalls ?? 0) + 1;
    return;
  }
  const count = state.toolCallCounts.get(toolName) ?? 0;
  state.toolCallCounts.set(toolName, count + 1);
}
