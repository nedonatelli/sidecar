import type { ToolResultContentBlock, ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Identical-edit reprompt — post-turn policy.
//
// A `search` equal to its `replace` is a no-op: the model has pointed at the
// right region and then failed to say what it should become. edit_file rejects
// it, but the rejection arrives as a tool_result buried behind a 30K-token
// prompt, and the model mostly does not act on it.
//
// Measured over three 50-task SWE-bench runs (558 edit_file calls, 349
// failures) this is the largest failure bucket by a wide margin:
//
//    130 (37%)  search == replace
//     84 (24%)  search text not found
//     37 (11%)  ambiguous (N matches)
//     35 (10%)  resubmitted the identical edit
//
// and it does not self-correct: only 30% of the 130 ever land a successful edit
// on that file, while 80 of them immediately retry edit_file -- which is where
// the 35 resubmissions come from.
//
// The shape of it argues for a nudge rather than a better error string. The
// rate is WORST at the start of a run and improves as feedback accumulates:
// 33% of edits in the first eight tool calls, 20% by call 8-15, 12% by call
// 24-31, and 38% of runs open with a no-op edit. Reading the file first does
// not help (23% identical even when it was read). It is a cold-start problem,
// so what the model needs is salience at the moment it happens, not more
// instructions in a prompt it has already shown it cannot follow at depth --
// the same reasoning that put actionReprompt in this file.
//
// One nudge per file. A model that ignores it falls through to the existing
// "AGAIN" escalation and then to cycle detection, rather than being nudged in
// a loop.
// ---------------------------------------------------------------------------

/** Max nudges per file before the existing escalation path takes over. */
const IDENTICAL_REPROMPT_MAX = 1;

/** How much of the model's own search text to quote back at it. */
const QUOTE_LIMIT = 400;

/**
 * The two ways edit_file reports a no-op edit. Matched on the message rather
 * than a flag because the tool signals it by throwing, and the loop only ever
 * sees the rendered text.
 */
function isIdenticalEditFailure(result: ToolResultContentBlock | undefined): boolean {
  if (!result?.is_error) return false;
  const text = typeof result.content === 'string' ? result.content : String(result.content ?? '');
  return (
    text.includes('search and replace text are identical') ||
    text.includes('you resubmitted the EXACT SAME search and replace')
  );
}

function editPath(tu: ToolUseContentBlock): string | undefined {
  const input = tu.input as Record<string, unknown>;
  const v = input.path ?? input.file_path;
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Nudge the model when it submits an edit whose `search` and `replace` are the
 * same string. Returns `true` when a nudge was injected.
 */
export function applyIdenticalEditReprompt(
  state: LoopState,
  pendingToolUses: ToolUseContentBlock[],
  toolResults: ToolResultContentBlock[],
  callbacks: AgentCallbacks,
): boolean {
  // Diagnostic escape hatch, mirroring SIDECAR_DISABLE_CYCLE_DETECTION: the
  // only way to A/B this hook is to be able to turn it off in one arm while
  // everything else stays byte-identical.
  if (process.env.SIDECAR_DISABLE_IDENTICAL_REPROMPT === 'true') return false;

  const byId = new Map(toolResults.map((r) => [r.tool_use_id, r]));
  for (const tu of pendingToolUses) {
    if (tu.name !== 'edit_file') continue;
    if (!isIdenticalEditFailure(byId.get(tu.id))) continue;

    const path = editPath(tu);
    if (!path) continue;
    const used = state.identicalEditRepromptsByFile.get(path) ?? 0;
    if (used >= IDENTICAL_REPROMPT_MAX) continue;
    state.identicalEditRepromptsByFile.set(path, used + 1);

    const input = tu.input as Record<string, unknown>;
    const search = typeof input.search === 'string' ? input.search : '';
    const quoted = search.length > QUOTE_LIMIT ? `${search.slice(0, QUOTE_LIMIT)}\n…` : search;

    callbacks.onText(`\n💡 That edit changes nothing — ${path.split('/').pop()}\n`);
    state.messages.push({
      role: 'user',
      content: [
        {
          type: 'text' as const,
          text:
            `Your last edit_file call on ${path} sent the SAME text in 'search' and in 'replace', so it asked ` +
            `for no change and was rejected. You have already found the right place; what is missing is the ` +
            `new version of it.\n\n` +
            `This is the text you located:\n\`\`\`\n${quoted}\n\`\`\`\n\n` +
            `Call edit_file once more on ${path}, keeping that exact text in 'search', and put the CHANGED ` +
            `code in 'replace' — the version you want the file to have after the fix. The two fields must ` +
            `differ. If you no longer think this is the right region, call read_file instead and find the ` +
            `code that actually needs to change.`,
        },
      ],
    });
    return true;
  }
  return false;
}
