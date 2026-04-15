import type { ChatMessage } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

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
  callbacks.onToolChainFlush?.();

  if (callbacks.onSuggestNextSteps && state.iteration > 1) {
    const suggestions = generateNextStepSuggestions(state.messages);
    if (suggestions.length > 0) {
      callbacks.onSuggestNextSteps(suggestions);
    }
  }

  state.logger?.logDone(state.iteration);
  callbacks.onDone();
  return state.messages;
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
