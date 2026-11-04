// Fence-write coercion, second half: decide whether the write_file a turn's
// printed code block was turned into should run at all.
//
// streamTurn.resolveTurnContent synthesizes the write (it is synchronous and
// cannot read the file); this runs in the loop, before dispatch, where it can.
//
// The case it exists for (2026-10-15 release eval, gemma4:31b): the model made
// the right edit with edit_file, then ended its turn the way a person would --
// "I have updated FieldValidator7.is_within_bounds ... ```python <the edited
// lines>```". With no test in the fixture nothing had VERIFIED the edit, so the
// "work already done" suppression did not apply, and the summary's code block
// was written to disk as if it were new code. The write was refused (a snippet
// over an edited file), but the refusal and the "stop rewriting" nudge pushed a
// finished model back to work: it went hunting for tests, printed more blocks,
// got more coercions. All 6 trials of large-file-derived-boundary-edit and
// large-file-anchored-insertion failed this way after a correct first edit.
//
// A printed block whose lines are already in the file, in order, is the model
// SHOWING the file, not asking to change it: there is nothing to write.

import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';
import type { TurnResult } from './streamTurn.js';
import { FENCE_WRITE_ID_PREFIX } from './textParsing.js';
import { claimToolUseId } from './toolUseIds.js';

/** Non-blank-trimmed lines of `fence`, compared trailing-whitespace-insensitive, appear as one contiguous run in `file`. */
export function fenceAlreadyInFile(fence: string, file: string): boolean {
  const norm = (s: string): string[] => s.split(/\r\n|\r|\n/).map((l) => l.replace(/[ \t]+$/, ''));
  const want = norm(fence);
  while (want.length > 0 && want[0] === '') want.shift();
  while (want.length > 0 && want[want.length - 1] === '') want.pop();
  if (want.length === 0) return false;
  const have = norm(file);
  outer: for (let i = 0; i + want.length <= have.length; i++) {
    for (let k = 0; k < want.length; k++) if (have[i + k] !== want[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Dispatch the turn's synthesized fence write, unless its code is already in
 * the target file. Mutates `resolved` (pending tool uses, stop reason).
 */
export async function applyFenceWrite(
  resolved: TurnResult,
  state: LoopState,
  callbacks: AgentCallbacks,
  read: (path: string) => Promise<string | null>,
): Promise<void> {
  state.printedCodeAlreadyInFile = false;
  const fence = resolved.fenceWrite;
  const shown = resolved.printedCode;
  if (!fence && !shown) return;
  const target = fence?.path ?? shown!.path;
  const current = await read(target);
  // The printed code is checked as the RESULT it shows: for change notation
  // (`<<<<` old `====` new `>>>>`, a diff) that is the new side.
  const inFile =
    current !== null &&
    ((shown !== undefined && fenceAlreadyInFile(shown.code, current)) ||
      (fence !== undefined && fenceAlreadyInFile(fence.content, current)));
  if (inFile) {
    state.printedCodeAlreadyInFile = true;
    state.logger?.info(`Printed code for ${target} is already in the file: no fence write, no "not saved" reprompt`);
    return;
  }
  if (!fence) return;
  state.fenceWriteCoercions++;
  const tu = {
    type: 'tool_use' as const,
    id: `${FENCE_WRITE_ID_PREFIX}${state.fenceWriteCoercions}`,
    name: 'write_file',
    input: { path: fence.path, content: fence.content },
  };
  // The counter is per run, but a chat's earlier runs counted from 1 too (#417).
  claimToolUseId(state.toolUseIds, tu);
  resolved.pendingToolUses.push(tu);
  resolved.stopReason = 'tool_use';
  state.logger?.info(
    `Fence-write coercion (${state.fenceWriteCoercions}/2): synthesized write_file(${fence.path}) ` +
      `from a printed code fence with no tool call`,
  );
  callbacks.onText(`\n✍️ No tool call was made — writing the code block you printed to ${fence.path}.\n`);
  state.logger?.logToolCall(tu.name, tu.input);
  callbacks.onToolCall(tu.name, tu.input, tu.id);
}
