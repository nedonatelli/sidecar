import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import { classifyFailureBucket, type RunFailureSignals } from '../failureTaxonomy.js';

/** Gate injection cap mirrored from gate.ts — used to detect an exhausted gate. */
const MAX_GATE_INJECTIONS = 2;

// ---------------------------------------------------------------------------
// Post-loop teardown for runAgentLoop.
//
// Runs after the main iteration loop exits (whether via break or
// natural termination). Handles three things:
//
//   1. Flush the tool-chain recorder buffer so any partial chain is
//      persisted.
//   2. Generate next-step suggestions from the tools used in the
//      run and emit them via `onSuggestNextSteps` (only when the
//      agent actually ran more than one iteration — for a single
//      Q&A turn we don't want to suggest follow-ups).
//   3. Log the done banner and fire `onDone` so observers know the
//      run has completed.
//
// `generateNextStepSuggestions` was an unnamed helper at the bottom
// of loop.ts; moving it here keeps the suggestion logic alongside
// the single caller that uses it.
// ---------------------------------------------------------------------------

/**
 * Run the post-loop teardown: flush the tool-chain buffer, emit
 * next-step suggestions (when meaningful), and fire onDone. Takes
 * `state` and `callbacks` so the function can log via state.logger
 * and observe `callbacks.onDone` in a single call.
 */
export function finalize(state: LoopState, callbacks: AgentCallbacks): ChatMessage[] {
  // Guard each callback independently so a throw in one cannot prevent
  // onDone() from firing and leaving the UI in a permanent spinner state.
  try {
    callbacks.onToolChainFlush?.();
  } catch (e) {
    state.logger?.error(`onToolChainFlush error: ${e}`);
  }

  if (callbacks.onSuggestNextSteps && state.iteration > 1) {
    try {
      const suggestions = generateNextStepSuggestions(state.messages);
      if (suggestions.length > 0) callbacks.onSuggestNextSteps(suggestions);
    } catch (e) {
      state.logger?.error(`onSuggestNextSteps error: ${e}`);
    }
  }

  // F1 — classify the run into a failure bucket (or null for success) from
  // the signals the loop accumulated, and report it before onDone so the
  // metrics collector can stamp the in-progress run.
  try {
    callbacks.onOutcome?.(classifyFailureBucket(buildRunFailureSignals(state)));
  } catch (e) {
    state.logger?.error(`onOutcome error: ${e}`);
  }

  state.logger?.logDone(state.iteration);
  callbacks.onDone();
  return state.messages;
}

/**
 * Derive the F1 classification signals from a completed run's LoopState.
 *
 * `termination` is the explicit exit reason the loop recorded; when it's
 * undefined the while-loop condition fell through, which means the iteration
 * cap was reached. Tool-call counts come from the final message history so we
 * don't have to thread counters through every dispatch path; gate exhaustion
 * is inferred from the gate having spent its full injection budget while
 * edited files were still outstanding.
 */
export function buildRunFailureSignals(state: LoopState): RunFailureSignals {
  let toolCalls = 0;
  let toolErrors = 0;
  for (const msg of state.messages) {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') toolCalls++;
      if (block.type === 'tool_result' && block.is_error) toolErrors++;
    }
  }

  const maxGateInjections = state.scaffoldingProfile?.maxGateInjections ?? MAX_GATE_INJECTIONS;
  const gateInjections = state.gateState?.gateInjections ?? 0;
  const editedFiles = state.gateState?.editedFiles?.size ?? 0;
  const gateExhausted = gateInjections >= maxGateInjections && editedFiles > 0;

  return {
    completedNaturally: state.termination === 'natural',
    aborted: state.termination === 'aborted',
    // Both the iteration cap and resource exhaustion (token budget / request
    // timeout) are "ran out of room before finishing" → the timeout bucket.
    hitMaxIterations: state.termination === 'max-iterations' || state.termination === 'out-of-resources',
    unrepairedMalformedCalls: state.unrepairedMalformedCalls,
    toolCalls,
    toolErrors,
    gateExhausted,
  };
}

/**
 * Analyze the completed agent conversation to suggest relevant
 * follow-up actions. Scans tool usage to infer what the agent did
 * and what a natural next step would be — e.g. if it wrote files
 * but didn't run tests, suggest running tests. Capped at 3
 * suggestions so the UI stays tidy.
 */
function generateNextStepSuggestions(messages: ChatMessage[]): string[] {
  const suggestions: string[] = [];
  const toolsUsed = new Set<string>();
  let hadErrors = false;
  let wroteFiles = false;
  let ranTests = false;

  for (const msg of messages) {
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        toolsUsed.add(block.name);
        if (block.name === 'write_file' || block.name === 'edit_file') wroteFiles = true;
        if (block.name === 'run_tests') ranTests = true;
      }
      if (block.type === 'tool_result' && block.is_error) hadErrors = true;
    }
  }

  if (wroteFiles && !ranTests) {
    suggestions.push('Run tests to verify the changes');
  }
  if (hadErrors) {
    suggestions.push('Review errors and retry the failed steps');
  }
  if (wroteFiles) {
    suggestions.push('Review the diff before committing');
  }
  if (toolsUsed.has('search_files') && !wroteFiles) {
    suggestions.push('Apply the findings — edit the relevant files');
  }

  return suggestions.slice(0, 3);
}
