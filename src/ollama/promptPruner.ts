import type { ChatMessage, ContentBlock, ToolResultContentBlock, ToolUseContentBlock } from './types.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

/**
 * Tools whose output must never be dedup'd with a back-reference
 * (v0.62.1 p.2b — audit finding: the "identical to previous" mark
 * is a trap when a user asks the agent to re-read a file after
 * editing it; the agent gets the *pre-edit* content by reference
 * even though it wrote a newer version). Truncation still applies
 * — size management is legitimate — but the back-reference is not.
 *
 * Add tools here when their output (a) is expected to vary across
 * consecutive calls with identical inputs, or (b) carries user
 * intent that would be damaged by collapsing duplicates.
 */
const DEDUP_EXEMPT_TOOLS = new Set(['read_file', 'get_diagnostics', 'git_diff', 'git_status']);

/**
 * Lossy-but-bounded prompt pruning applied before sending to paid backends.
 *
 * Rules — each one documented so a failing agent loop can point at the
 * specific transform that swallowed its information:
 *
 *  1. Collapse 3+ consecutive blank lines to 2.
 *  2. Truncate oversize tool_result blocks to head + tail with an
 *     explicit elision marker naming the byte count dropped.
 *  3. Dedupe tool_result blocks that repeat the same file content within
 *     a single request — later duplicates become a back-reference.
 *
 * We do NOT touch user message text, assistant reasoning, or tool_use
 * inputs. The pruner is designed to be safe to enable by default.
 */

export interface PrunerOptions {
  enabled: boolean;
  maxToolResultTokens: number;
}

export interface PruneStats {
  /** Bytes removed from tool_result blocks via head+tail truncation. */
  truncatedBytes: number;
  /** Bytes saved from dedup (later duplicates replaced with a back-reference). */
  dedupedBytes: number;
  /** Bytes removed from collapsed whitespace runs. */
  whitespaceBytes: number;
  /**
   * v0.62.1 p.2a — per-tool truncation breakdown. Populated only
   * when a tool-name map is available (always in production; only
   * optionally in unit-test callers). Empty object when no
   * truncation happened or when the caller didn't supply a map.
   * Keyed by tool name; values are bytes dropped.
   */
  truncatedByTool: Record<string, number>;
}

const ELISION_MARK = '\n\n[...%d bytes elided by SideCar prompt pruner...]\n\n';
const DEDUP_MARK = '[identical to a previous tool_result in this request — see above]';

/** Collapse runs of 3+ blank lines to 2. Cheap, safe, no-op for normal prose. */
export function collapseWhitespace(text: string): { text: string; saved: number } {
  const before = text.length;
  const after = text.replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, '\n\n');
  return { text: after, saved: before - after.length };
}

/**
 * Head+tail truncation: keep the first ~60% and last ~40% of the budget,
 * insert an elision marker in the middle. Preserves error messages at the
 * top and the failing line at the bottom, which is typically where the
 * signal lives in tool output (cat'd file, compile error, test failure).
 *
 * This is the DEFAULT strategy — used for every tool that doesn't have
 * a dedicated per-tool strategy (see `truncateGrepResult` for the one
 * specialized case). See `docs/agent-loop-diagram.md#prompt-pruner-safety-model`
 * for the full list of truncation-friendly vs. truncation-hostile tools.
 */
export function truncateToolResult(text: string, maxTokens: number): { text: string; saved: number } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, saved: 0 };

  const headBudget = Math.floor(maxChars * 0.6);
  const tailBudget = maxChars - headBudget - 80; // 80 chars for the elision marker
  if (tailBudget <= 0) {
    // Budget too small for a meaningful tail — just head-truncate.
    const truncated = text.slice(0, maxChars);
    return { text: truncated, saved: text.length - truncated.length };
  }

  const head = text.slice(0, headBudget);
  const tail = text.slice(text.length - tailBudget);
  const elided = text.length - head.length - tail.length;
  const marker = ELISION_MARK.replace('%d', String(elided));
  const result = head + marker + tail;
  return { text: result, saved: text.length - result.length };
}

/**
 * Grep-aware truncation (v0.63.0). Unlike the default head+tail
 * transform, this keeps whole lines from the head and drops the tail
 * entirely. Grep output is line-uniform: one match per line, typically
 * `path:line:content`. Head+tail would elide matches 40-160 of a
 * 200-match result, leaving only 1-40 and 160-200, which are usually
 * the least-interesting matches (boilerplate imports + trailing tests).
 *
 * Keeping the first-K-matches instead preserves the natural grep
 * ordering (file-sorted, then line-sorted within a file) and lets the
 * agent see a contiguous window of the most-likely-relevant matches.
 *
 * When matches are elided, the marker tells the agent how many were
 * dropped and suggests narrowing the query — actionable guidance that
 * the default head+tail marker can't provide because head+tail doesn't
 * know the content is line-uniform.
 */
export function truncateGrepResult(text: string, maxTokens: number): { text: string; saved: number } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return { text, saved: 0 };

  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  // Reserve ~120 chars for the elision marker + suggestion.
  const budget = maxChars - 120;
  for (const line of lines) {
    // +1 for the newline the join will add back.
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }

  const elided = lines.length - kept.length;
  if (elided === 0) {
    // Every line fit — shouldn't happen since we checked text.length
    // above, but guard against the edge case where the last line is
    // huge and single-line-overflow.
    const truncated = text.slice(0, maxChars);
    return { text: truncated, saved: text.length - truncated.length };
  }

  const marker =
    `\n[...${elided} more match${elided === 1 ? '' : 'es'} elided by SideCar prompt pruner ` +
    `(kept first ${kept.length} of ${lines.length} matches). Narrow the grep query to see the rest.]`;
  const result = kept.join('\n') + marker;
  return { text: result, saved: text.length - result.length };
}

/**
 * Dispatch table for per-tool truncation strategies (v0.63.0). Maps a
 * tool name to the specialized truncation function. Anything not in
 * this map falls through to `truncateToolResult`'s head+tail default.
 *
 * Add an entry here when a tool has a truncation-hostile output shape
 * (matches distributed throughout, ranked hit lists where middle-items
 * matter, etc.). See `docs/agent-loop-diagram.md#prompt-pruner-safety-model`
 * for the guidance on which tools qualify.
 */
const TRUNCATION_DISPATCH: Record<string, (text: string, maxTokens: number) => { text: string; saved: number }> = {
  grep: truncateGrepResult,
};

/** Pick the right truncation strategy for a given tool name. Exported for tests. */
export function truncateForTool(
  toolName: string | undefined,
  text: string,
  maxTokens: number,
): { text: string; saved: number } {
  const strategy = toolName ? TRUNCATION_DISPATCH[toolName] : undefined;
  return (strategy ?? truncateToolResult)(text, maxTokens);
}

/** Normalize whitespace/trailing noise so two tool_result blocks hash-compare cleanly. */
function dedupKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Build a `tool_use_id → tool_name` map by walking the message
 * history's `tool_use` blocks (v0.62.1 p.2b). Tool names aren't
 * carried on `tool_result` blocks directly; to apply tool-aware
 * pruning rules we have to cross-reference the ID the result
 * points at. Returns an empty map if no tool_use blocks are found
 * — pruning falls back to the pre-p.2b all-tools-treated-alike
 * behavior in that case.
 */
export function buildToolUseIdMap(messages: ChatMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        const use = block as ToolUseContentBlock;
        out.set(use.id, use.name);
      }
    }
  }
  return out;
}

/**
 * Walk messages looking for duplicate tool_result content blocks. First
 * occurrence keeps its content; later occurrences get replaced with a
 * short back-reference. This is the biggest win when an agent reads the
 * same file twice in one loop.
 *
 * v0.62.1 p.2b — tools in `DEDUP_EXEMPT_TOOLS` (read_file, git_diff,
 * …) are never dedup'd; their output is expected to vary across
 * consecutive calls. `toolNames` parameter is optional for back-
 * compat — without it, every tool gets the pre-p.2b dedup treatment.
 */
export function dedupeToolResults(
  messages: ChatMessage[],
  toolNames?: Map<string, string>,
): { messages: ChatMessage[]; saved: number } {
  const seen = new Map<string, number>();
  let saved = 0;
  const out: ChatMessage[] = messages.map((m) => {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) return m;

    const newBlocks: ContentBlock[] = m.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const result = block as ToolResultContentBlock;
      if (typeof result.content !== 'string' || result.content.length < 200) return block;

      // Exempt tools whose output is expected to vary across calls.
      const toolName = toolNames?.get(result.tool_use_id);
      if (toolName && DEDUP_EXEMPT_TOOLS.has(toolName)) return block;

      const key = dedupKey(result.content);
      if (!seen.has(key)) {
        seen.set(key, result.content.length);
        return block;
      }
      saved += result.content.length - DEDUP_MARK.length;
      return { ...result, content: DEDUP_MARK } satisfies ToolResultContentBlock;
    });
    return { ...m, content: newBlocks };
  });

  return { messages: out, saved };
}

/** Apply truncation to every tool_result block in-place. `toolNames`
 *  is optional and only used to populate the per-tool breakdown in
 *  `PruneStats.truncatedByTool` — actual truncation still applies
 *  to every oversize block regardless of which tool produced it. */
export function truncateAllToolResults(
  messages: ChatMessage[],
  maxTokens: number,
  toolNames?: Map<string, string>,
): { messages: ChatMessage[]; saved: number; byTool: Record<string, number> } {
  let saved = 0;
  const byTool: Record<string, number> = {};
  const out: ChatMessage[] = messages.map((m) => {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) return m;
    const newBlocks: ContentBlock[] = m.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const result = block as ToolResultContentBlock;
      if (typeof result.content !== 'string') return block;
      // v0.63.0 — dispatch by tool name so grep (and future
      // truncation-hostile tools) get their specialized strategy.
      // Tools without a specialized strategy fall through to the
      // default head+tail transform.
      const toolName = toolNames?.get(result.tool_use_id);
      const { text, saved: s } = truncateForTool(toolName, result.content, maxTokens);
      if (s === 0) return block;
      saved += s;
      const bucketKey = toolName ?? 'unknown';
      byTool[bucketKey] = (byTool[bucketKey] ?? 0) + s;
      return { ...result, content: text } satisfies ToolResultContentBlock;
    });
    return { ...m, content: newBlocks };
  });
  return { messages: out, saved, byTool };
}

export interface PruneResult {
  systemPrompt: string;
  messages: ChatMessage[];
  stats: PruneStats;
}

/**
 * Top-level pruner entry point used by the Anthropic and OpenAI backends.
 * When `opts.enabled` is false, this is a no-op and returns the inputs
 * unchanged so the Ollama/Kickstand path can share the code.
 */
export function prunePrompt(systemPrompt: string, messages: ChatMessage[], opts: PrunerOptions): PruneResult {
  if (!opts.enabled) {
    return {
      systemPrompt,
      messages,
      stats: { truncatedBytes: 0, dedupedBytes: 0, whitespaceBytes: 0, truncatedByTool: {} },
    };
  }

  // v0.62.1 p.2b: build a tool_use_id → tool_name map so dedup can
  // exempt critical tools (read_file et al.) and the stats breakdown
  // can attribute bytes to specific tools for the observability
  // report (p.2a).
  const toolNames = buildToolUseIdMap(messages);
  const sys = collapseWhitespace(systemPrompt);
  const truncated = truncateAllToolResults(messages, opts.maxToolResultTokens, toolNames);
  const deduped = dedupeToolResults(truncated.messages, toolNames);

  return {
    systemPrompt: sys.text,
    messages: deduped.messages,
    stats: {
      truncatedBytes: truncated.saved,
      dedupedBytes: deduped.saved,
      whitespaceBytes: sys.saved,
      truncatedByTool: truncated.byTool,
    },
  };
}

/**
 * Format a `PruneStats` into a one-line summary for the agent
 * logger (v0.62.1 p.2a). Returns empty string when no pruning
 * actually happened, so callers can skip the log entry in the
 * overwhelmingly common case.
 */
export function formatPruneStats(stats: PruneStats): string {
  const total = stats.truncatedBytes + stats.dedupedBytes + stats.whitespaceBytes;
  if (total === 0) return '';
  const parts: string[] = [];
  if (stats.truncatedBytes > 0) {
    const byTool = Object.entries(stats.truncatedByTool)
      .sort((a, b) => b[1] - a[1])
      .map(([name, bytes]) => `${name}:${bytes}B`)
      .join(' ');
    parts.push(`truncated ${stats.truncatedBytes}B${byTool ? ` (${byTool})` : ''}`);
  }
  if (stats.dedupedBytes > 0) parts.push(`deduped ${stats.dedupedBytes}B`);
  if (stats.whitespaceBytes > 0) parts.push(`whitespace ${stats.whitespaceBytes}B`);
  return `Pruner: ${parts.join(', ')}`;
}
