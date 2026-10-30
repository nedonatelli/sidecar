import type { ToolResultContentBlock } from '../../ollama/types.js';

const FILE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file']);

/**
 * A "No change needed" answer: the edit's search equalled its replace, or the
 * file already held the content. Not an error, and not a change either.
 */
const NO_CHANGE = /(?:^|\n)No change needed: /;

/**
 * Whether a file tool's result changed a file, for `state.fileMutations`.
 *
 * A "No change needed" result used to count, because it isn't an error. That is
 * the largest edit_file failure bucket (search === replace), so a run that had
 * changed nothing switched off the action reprompt's "already done?" escape and
 * the read-only cycle nudge as if it had (#361).
 */
export function countsAsFileMutation(
  toolName: string | undefined,
  result: ToolResultContentBlock | undefined,
): boolean {
  if (!toolName || !FILE_TOOLS.has(toolName)) return false;
  if (!result || result.is_error) return false;
  return !NO_CHANGE.test(result.content);
}
