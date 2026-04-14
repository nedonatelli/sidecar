import { CHARS_PER_TOKEN, CONTEXT_COMPRESSION_THRESHOLD } from '../../config/constants.js';
import { SideCarClient } from '../../ollama/client.js';
import type { ChatMessage, ContentBlock } from '../../ollama/types.js';
import { ConversationSummarizer } from '../conversationSummarizer.js';
import { ToolResultCompressor } from '../toolResultCompressor.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Tool-result compression (the lower-level helper the loop-level
// compression calls into). Previously lived at the bottom of loop.ts
// where it was tangled in with unrelated dedup / suggestion helpers.
// Moved here because it's the core primitive every compression
// strategy above this layer composes.
//
// Compresses old tool results in a message history by tiered
// max-length caps based on distance from the end:
//   - last 2 messages: untouched
//   - 2..6 from end: max 1000 chars per tool_result
//   - 6+ from end: max 200 chars
// Old `thinking` blocks (8+ from end) are dropped entirely because
// nothing downstream re-reads them.
//
// Returns the number of characters freed so the caller can update
// totalChars accounting.
// ---------------------------------------------------------------------------

export function compressMessages(messages: ChatMessage[]): number {
  let freed = 0;
  const len = messages.length;
  const compressor = new ToolResultCompressor();

  for (let i = 0; i < len; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

    const distFromEnd = len - 1 - i;
    let maxLen: number;
    if (distFromEnd < 2) continue;
    else if (distFromEnd < 6) maxLen = 1000;
    else maxLen = 200;

    const newContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.content.length > maxLen) {
        const original = block.content.length;
        const compressionResult = compressor.compress(block.content, maxLen);
        const compressed = compressionResult.content;
        newContent.push({ ...block, content: compressed });
        freed += original - compressed.length;
      } else if (block.type === 'thinking' && distFromEnd >= 8) {
        freed += block.thinking.length;
      } else {
        newContent.push(block);
      }
    }
    messages[i] = { ...msg, content: newContent };
  }

  return freed;
}

// ---------------------------------------------------------------------------
// Context compression helpers for runAgentLoop.
//
// Two sites in the iteration body compress the agent's message
// history:
//
//   1. At iteration start, *before* streaming the next response, when
//      estimated tokens exceed CONTEXT_COMPRESSION_THRESHOLD (70%) of
//      the budget. Both strategies fire: ConversationSummarizer
//      replaces old turns with a summary, and compressMessages
//      truncates oversize tool-result bodies in place. Running both
//      maximises freed space because they target different content.
//
//   2. After tool results are appended to the history, in case a
//      long tool_result pushed us back over the threshold mid-turn.
//      This is a lighter-weight check — only compressMessages fires,
//      not summarization, because summarizing mid-turn would drop
//      state the current iteration still depends on.
//
// Both helpers mutate `state.messages` and `state.totalChars`
// in place. The caller observes the result by re-reading those
// fields (or by the `CompressionOutcome` return, for the pre-turn
// helper, which also tells the orchestrator whether to bail on
// budget exhaustion).
// ---------------------------------------------------------------------------

export type CompressionOutcome = 'ok' | 'exhausted';

/**
 * Run pre-turn compression when the agent is near the token budget.
 * Returns `'exhausted'` when compaction couldn't bring us below the
 * hard ceiling, so the orchestrator knows to stop the loop with a
 * budget-exceeded notification. Returns `'ok'` in every other case
 * (including "we didn't need to compress").
 */
export async function applyBudgetCompression(client: SideCarClient, state: LoopState): Promise<CompressionOutcome> {
  let estimatedTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);

  if (estimatedTokens > state.maxTokens * CONTEXT_COMPRESSION_THRESHOLD) {
    // 1. Summarize old turns.
    const summarizer = new ConversationSummarizer(client);
    const summarized = await summarizer.summarize(state.messages, {
      keepRecentTurns: 2,
      minCharsToSave: 2000,
      maxSummaryLength: 800,
      summaryTimeoutMs: 5000,
    });
    if (summarized.freedChars > 0) {
      state.messages.splice(0, state.messages.length, ...summarized.messages);
      state.totalChars -= summarized.freedChars;
      state.logger?.info(
        `Conversation summarized: ${summarized.metadata.turnsSummarized}/${summarized.metadata.turnsCount} turns compressed, freed ${summarized.freedChars} chars`,
      );
    }

    // 2. Compress tool results too — targets different content than
    //    summarization, so running both maximises freed space.
    const compressed = compressMessages(state.messages);
    if (compressed) {
      state.logger?.info(`Context compressed: removed ${compressed} chars of old tool results`);
      state.totalChars -= compressed;
    }

    estimatedTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);
  }

  return estimatedTokens > state.maxTokens ? 'exhausted' : 'ok';
}

/**
 * Run lighter mid-turn compression after tool results are added to
 * the history. Only `compressMessages` fires — summarization would
 * drop state the current iteration still depends on.
 *
 * Returns nothing; the caller's view of state.totalChars is updated
 * in place.
 */
export function maybeCompressPostTool(state: LoopState): void {
  const postToolTokens = Math.ceil(state.totalChars / CHARS_PER_TOKEN);
  if (postToolTokens > state.maxTokens * CONTEXT_COMPRESSION_THRESHOLD) {
    const compressed = compressMessages(state.messages);
    if (compressed) {
      state.totalChars -= compressed;
      state.logger?.info(`Post-tool compression: removed ${compressed} chars`);
    }
  }
}
