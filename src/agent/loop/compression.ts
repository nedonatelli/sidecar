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
// Compresses old tool results in a message history using semantic
// importance tiers rather than a flat distance-from-end heuristic:
//
//   error   — never compressed. Error context is always diagnostic.
//   write   — protected for 3 full turns (6 messages); then 1000→200.
//   read    — compressed aggressively from turn 2; 500→150 chars.
//   other   — legacy behaviour: 2 messages untouched, 1000→200 chars.
//
// Images in the heavy tier (6+ from end) are replaced with a compact
// placeholder. Old `thinking` blocks (8+ from end) are dropped when
// standalone, or truncated to 200 chars when paired with a tool_use
// (Anthropic requires thinking to precede tool_use — dropping causes 400).
//
// Returns the number of characters freed so the caller can update
// totalChars accounting.
// ---------------------------------------------------------------------------

/** Tools that mutate state — protect results for 3 full turns (6 messages). */
const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'git_commit',
  'git_stage',
  'git_push',
  'git_pull',
  'git_stash',
  'db_execute',
  'db_migrate_up',
]);

/** Tools that only read / search — compress aggressively. */
const READ_TOOL_NAMES = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'find_files',
  'git_diff',
  'git_status',
  'git_log',
  'git_branch',
  'git_search_history',
  'web_search',
  'project_knowledge_search',
  'get_diagnostics',
  'check_dependencies',
  'monorepo_packages',
  'analyze_ci_failure',
  'db_list_connections',
  'db_list_tables',
  'db_describe_table',
  'db_query',
  'read_pdf',
  'index_pdf',
  'profile_code',
  'display_diagram',
  'ingest_source',
  'generate_briefing',
  'generate_study_guide',
  'generate_faq',
  'generate_timeline',
  'generate_outline',
]);

type CompressionTier = 'error' | 'write' | 'read' | 'other';

/** Build a tool_use_id → tool_name map by scanning all messages once. */
function buildToolNameMap(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use') map.set(block.id, block.name);
    }
  }
  return map;
}

function compressionTier(toolUseId: string, isError: boolean, toolNameMap: Map<string, string>): CompressionTier {
  if (isError) return 'error';
  const name = toolNameMap.get(toolUseId) ?? '';
  if (WRITE_TOOL_NAMES.has(name)) return 'write';
  if (READ_TOOL_NAMES.has(name)) return 'read';
  return 'other';
}

/** Tools whose results should never be compressed away — they establish context
 *  the agent needs for the rest of the session (repo root, deps tree, etc.). */
const STATE_ESTABLISHING_TOOLS = new Set(['git_clone', 'npm_install', 'run_command']);

/**
 * Memoises `ToolResultCompressor.compress` output so identical tool-result
 * bodies (e.g. repeated read_file on the same file) are only compressed once
 * per session. The cache is cleared between agent runs via `clearCompressionCache`.
 *
 * Key: `${fnv1a32(content)}:${content.length}:${maxLen}` — full-content hash,
 * collision probability ~1/4B per pair regardless of shared prefixes/suffixes.
 */
const compressionCache = new Map<string, string>();

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

function compressionKey(content: string, maxLen: number): string {
  return `${fnv1a32(content)}:${content.length}:${maxLen}`;
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
  const toolNameMap = buildToolNameMap(messages);

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
    // The most aggressive tier (read) compresses from distFromEnd >= 1;
    // nothing in any tier compresses at distFromEnd 0 (the current message).
    if (distFromEnd < 1) continue;

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
      } else if (block.type === 'tool_result') {
        const tier = compressionTier(block.tool_use_id, !!block.is_error, toolNameMap);
        let maxLen: number;

        if (tier === 'error') {
          // Error results document what went wrong — preserve them at any age
          // so the agent retains full diagnostic context throughout the session.
          newContent.push(block);
          continue;
        } else if (tier === 'write') {
          // Protect write outcomes for 3 full turns (6 messages) so the agent
          // can reference the edit context; then apply standard thresholds.
          if (distFromEnd < 6) {
            newContent.push(block);
            continue;
          }
          maxLen = distFromEnd < 12 ? 1_000 : 200;
        } else if (tier === 'read') {
          // Read / search results go stale quickly — compress from turn 2.
          if (distFromEnd < 1) {
            newContent.push(block);
            continue;
          }
          maxLen = distFromEnd < 5 ? 500 : 150;
        } else {
          // 'other' — shell commands, git mutations, tests, etc.: legacy behaviour.
          if (distFromEnd < 2) {
            newContent.push(block);
            continue;
          }
          maxLen = distFromEnd < 6 ? 1_000 : 200;
        }

        if (block.content.length > maxLen) {
          const original = block.content.length;
          const cacheKey = compressionKey(block.content, maxLen);
          let compressed = compressionCache.get(cacheKey);
          if (compressed === undefined) {
            compressed = compressor.compress(block.content, maxLen).content;
            compressionCache.set(cacheKey, compressed);
          }
          newContent.push({ ...block, content: compressed });
          freed += original - compressed.length;
        } else {
          newContent.push(block);
        }
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
 * Replace the generic "Understood" assistant ack that the summarizer injects
 * after compression with a structured anchor listing files already modified
 * and warning against repeating failed approaches. This gives the model an
 * explicit in-context signal after the old turns have been compressed away.
 */
function enhancePostCompressionAck(summaryText: string): string {
  const base = 'I have reviewed the summarized context.';

  const match = summaryText.match(/## Code changes\n([\s\S]*?)(?=\n##|$)/);
  const changeLines = match
    ? match[1]
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('-'))
    : [];

  if (changeLines.length === 0) {
    return `${base} I will not retry approaches that have already been attempted and failed.`;
  }

  return (
    `${base} Files I have already modified in this session:\n` +
    changeLines.join('\n') +
    '\n\nI will build on this existing work rather than starting over, and will not retry approaches that have already failed.'
  );
}

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

      // Enhance the assistant acknowledgment (messages[1]) with a concrete
      // list of already-modified files so the model doesn't restart from
      // scratch or retry approaches that failed before compression.
      const ackMsg = state.messages[1];
      if (ackMsg?.role === 'assistant' && typeof ackMsg.content === 'string') {
        const summaryMsgForAck = state.messages[0];
        const summaryForAck = typeof summaryMsgForAck?.content === 'string' ? summaryMsgForAck.content : '';
        state.messages[1] = { ...ackMsg, content: enhancePostCompressionAck(summaryForAck) };
      }

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
