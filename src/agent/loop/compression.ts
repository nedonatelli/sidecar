import { CONTEXT_COMPRESSION_THRESHOLD } from '../../config/constants.js';
import { estimateTokensFromState } from '../../config/tokenEstimation.js';
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
// Old `thinking` blocks (8+ from end) are dropped when standalone, or
// truncated to 200 chars when paired with a tool_use (Anthropic requires
// thinking blocks to precede their tool_use — dropping them causes a 400).
//
// Returns the number of characters freed so the caller can update
// totalChars accounting.
// ---------------------------------------------------------------------------

/** Tools whose results should never be compressed away — they establish context
 *  the agent needs for the rest of the session (repo root, deps tree, etc.). */
const STATE_ESTABLISHING_TOOLS = new Set(['git_clone', 'npm_install', 'run_command']);

/**
 * Memoises `ToolResultCompressor.compress` output so identical tool-result
 * bodies (e.g. repeated read_file on the same file) are only compressed once
 * per session. The cache is cleared between agent runs via `clearCompressionCache`.
 *
 * Key: `${length}:${head64}:${tail64}:${maxLen}` — cheap, no crypto needed.
 * Collisions are impossible in practice because a collision would require two
 * strings that share length, first 64 chars, last 64 chars, and maxLen yet
 * differ in the middle — extremely unlikely for tool result content.
 */
const compressionCache = new Map<string, string>();

function compressionKey(content: string, maxLen: number): string {
  const head = content.slice(0, 64);
  const tail = content.length > 64 ? content.slice(-64) : '';
  return `${content.length}:${maxLen}:${head}:${tail}`;
}

/** Clear the compression cache — called at agent-loop teardown. */
export function clearCompressionCache(): void {
  compressionCache.clear();
}

function isStateEstablishingResult(msg: ChatMessage, prevMsg: ChatMessage | undefined): boolean {
  if (!prevMsg || msg.role !== 'user' || typeof msg.content === 'string') return false;
  if (!Array.isArray(prevMsg.content)) return false;
  // A user message's tool_results are state-establishing when the preceding
  // assistant message's tool_use names are in STATE_ESTABLISHING_TOOLS.
  return prevMsg.content.some((b) => b.type === 'tool_use' && STATE_ESTABLISHING_TOOLS.has(b.name));
}

export function compressMessages(messages: ChatMessage[]): number {
  let freed = 0;
  const len = messages.length;
  const compressor = new ToolResultCompressor();

  for (let i = 0; i < len; i++) {
    const msg = messages[i];
    if (typeof msg.content === 'string' || !Array.isArray(msg.content)) continue;

    // messages[0] is the user's original task — protect it from compression.
    // Real initial messages are always role:'user' with pure text blocks and
    // nothing else. Only those get the exemption; image/tool_result blocks at
    // index 0 (test artifacts or unusual flows) remain compressible.
    if (i === 0 && msg.role === 'user' && msg.content.every((b) => b.type === 'text')) continue;

    // Tool results from state-establishing commands (git_clone, npm install, etc.)
    // are compression-immune: the agent needs them for the full session.
    if (isStateEstablishingResult(msg, messages[i - 1])) continue;

    const distFromEnd = len - 1 - i;
    let maxLen: number;
    if (distFromEnd < 2) continue;
    else if (distFromEnd < 6) maxLen = 1000;
    else maxLen = 200;

    // Detect whether this message contains a tool_use block. Anthropic's
    // Extended Thinking API requires that every thinking block immediately
    // precede its paired tool_use in the same message. Dropping the
    // thinking block while keeping the tool_use produces a 400 Bad Request
    // ("thinking must precede tool_use"). When the pair is present we
    // truncate the thinking block instead of dropping it.
    const hasToolUse = msg.content.some((b) => b.type === 'tool_use');

    const newContent: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type === 'image' && distFromEnd >= 6) {
        // Heavy compression tier: replace image data with a compact text
        // placeholder so it no longer dominates the context budget.
        // Images in the last 2–5 messages (light tier) are left intact.
        const rawBytes = Math.ceil((block.source.data.length * 3) / 4);
        const sizeKB = Math.max(1, Math.round(rawBytes / 1024));
        const placeholder = `[image: ${block.source.media_type}, ~${sizeKB}KB — dropped for context budget]`;
        newContent.push({ type: 'text', text: placeholder });
        freed += Math.max(0, block.source.data.length - placeholder.length);
      } else if (block.type === 'tool_result' && block.content.length > maxLen) {
        const original = block.content.length;
        const cacheKey = compressionKey(block.content, maxLen);
        let compressed = compressionCache.get(cacheKey);
        if (compressed === undefined) {
          compressed = compressor.compress(block.content, maxLen).content;
          compressionCache.set(cacheKey, compressed);
        }
        newContent.push({ ...block, content: compressed });
        freed += original - compressed.length;
      } else if (block.type === 'thinking' && distFromEnd >= 8) {
        if (hasToolUse) {
          // Atomic thinking→tool_use chain: truncate instead of drop so
          // Anthropic's signed-thinking verification stays intact.
          const TRUNCATION_SUFFIX = '… (truncated)';
          const maxThinkingChars = 200;
          if (block.thinking.length > maxThinkingChars) {
            freed += block.thinking.length - maxThinkingChars;
            // Slice to (maxThinkingChars - suffix.length) so the final string
            // stays within the cap — appending after the slice would exceed it.
            const keepChars = Math.max(0, maxThinkingChars - TRUNCATION_SUFFIX.length);
            newContent.push({ ...block, thinking: block.thinking.slice(0, keepChars) + TRUNCATION_SUFFIX });
          } else {
            newContent.push(block);
          }
        } else {
          // Standalone thinking with no tool_use — safe to drop entirely.
          freed += block.thinking.length;
        }
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
  // Prefer actual token count from the last API usage event; fall back to
  // script-type-aware char-based estimation when we don't have it yet.
  let estimatedTokens = state.lastActualInputTokens ?? estimateTokensFromState(state.totalChars, state.messages);

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

      // Index the batch summary in episodic memory so semantically
      // relevant prior context can be retrieved in future turns.
      const summaryMsg = summarized.messages[0];
      const summaryText = summaryMsg && typeof summaryMsg.content === 'string' ? summaryMsg.content : '';
      if (summaryText) {
        await state.episodicMemory.add(summaryText, summarized.metadata.turnsSummarized).catch((err: unknown) => {
          state.logger?.info(`Episodic memory indexing failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        state.episodicMemory.persist().catch((err: unknown) => {
          state.logger?.info(`Episodic memory persist failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    // 2. Compress tool results too — targets different content than
    //    summarization, so running both maximises freed space.
    const compressed = compressMessages(state.messages);
    if (compressed) {
      state.logger?.info(`Context compressed: removed ${compressed} chars of old tool results`);
      state.totalChars -= compressed;
    }

    // After compressing, actual token count is stale — reestimate from chars
    // since we've modified the message history.
    state.lastActualInputTokens = undefined;
    estimatedTokens = estimateTokensFromState(state.totalChars, state.messages);
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
  const postToolTokens = estimateTokensFromState(state.totalChars, state.messages);
  if (postToolTokens > state.maxTokens * CONTEXT_COMPRESSION_THRESHOLD) {
    const compressed = compressMessages(state.messages);
    if (compressed) {
      state.totalChars -= compressed;
      state.lastActualInputTokens = undefined;
      state.logger?.info(`Post-tool compression: removed ${compressed} chars`);
    }
  }
}
