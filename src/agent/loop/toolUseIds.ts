import type { ChatMessage, ToolUseContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tool-use ids unique within a run (#417).
//
// state.toolOutcomes (ADR-008) and every id→name map key on tool_use_id, so
// they need one id per call. Backends and parsers number their calls per
// request: native Ollama's first call is `ollama_tc_0` on every turn, and the
// text-form parsers count `text_tc_N` / `stream_tc_N` from 0 each time. A
// read_file in turn 2 then found turn 1's edit outcome under the same id and
// counted as a file change; a no-op edit hid an earlier real one.
//
// A repeated id gets a `-N` suffix before anything sees it. Hyphen, not `#`:
// Anthropic accepts only [a-zA-Z0-9_-] in a tool_use id, and text-form ids are
// sent back to whichever backend is active.
// ---------------------------------------------------------------------------

/** The tool_use ids already in a conversation, so a run never reuses one from earlier in the chat. */
export function toolUseIdsIn(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) if (block.type === 'tool_use') ids.add(block.id);
  }
  return ids;
}

/** Give `tu` an id not in `ids` (renaming it in place if needed), and record it. */
export function claimToolUseId(ids: Set<string>, tu: ToolUseContentBlock): void {
  if (ids.has(tu.id)) {
    let n = 2;
    while (ids.has(`${tu.id}-${n}`)) n++;
    tu.id = `${tu.id}-${n}`;
  }
  ids.add(tu.id);
}
