// No-op edit, second half (#328): apply the new code the no-op error asked for.
//
// When edit_file is sent search === replace and `search` is already in the
// file, the error (sidecar.editFile.noopAsksForNewCode) quotes the search back
// as correct and asks for ONLY the new version in a code block — no tool call.
// This turns that reply into edit_file(path, search, <block>).
//
// Replayed over 150 recorded no-ops (gemma4:e4b, 37 SWE tasks), that wording
// got a real change on the next turn 75 times against 47 for the old hints; 30
// of the 75 came as a code block, the rest as an edit_file call the model made
// anyway. Without this, those 30 blocks would reach fence-write coercion and
// could be written over the whole file.
//
// It runs before applyFenceWrite and only on the turn right after the no-op:
// any tool call, or a reply without a code block, drops the pending edit.

import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import type { TurnResult } from './streamTurn.js';

export const NOOP_NEW_CODE_ID_PREFIX = 'noop_newcode_';

/** The body of the first fenced code block in `text`, without its final newline; null when there is none. */
export function firstCodeBlock(text: string): string | null {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(text);
  return m ? m[1].replace(/\r?\n$/, '') : null;
}

const sameLines = (a: string, b: string): boolean => {
  const norm = (s: string): string =>
    s
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n');
  return norm(a) === norm(b);
};

/**
 * Turn the turn's code block into the pending no-op's edit_file call. Returns
 * true when it did. Mutates `resolved` (pending tool uses, stop reason, and
 * drops the fence write the same block would otherwise have become).
 */
export function applyNoopNewCode(resolved: TurnResult, state: LoopState, callbacks: AgentCallbacks): boolean {
  const pending = state.noopNewCodeRef.pending;
  if (!pending) return false;
  state.noopNewCodeRef.pending = null;
  if (resolved.pendingToolUses.length > 0) return false;
  const block = firstCodeBlock(resolved.fullText);
  if (block === null || block.trim() === '') return false;
  if (sameLines(block, pending.search)) {
    state.logger?.info(`No-op new code for ${pending.path}: the code block repeats the search text; nothing to apply`);
    return false;
  }
  const tu = {
    type: 'tool_use' as const,
    id: `${NOOP_NEW_CODE_ID_PREFIX}${state.iteration}`,
    name: 'edit_file',
    input: { path: pending.path, search: pending.search, replace: block },
  };
  resolved.pendingToolUses.push(tu);
  resolved.stopReason = 'tool_use';
  delete resolved.fenceWrite;
  delete resolved.printedCode;
  state.logger?.info(`No-op new code: synthesized edit_file(${pending.path}) from the code block asked for (#328)`);
  callbacks.onText(`\n✍️ Applying your new version to ${pending.path}.\n`);
  state.logger?.logToolCall(tu.name, tu.input);
  callbacks.onToolCall(tu.name, tu.input, tu.id);
  return true;
}
