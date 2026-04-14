import type { ChatMessage, ContentBlock, ToolResultContentBlock } from './types.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';

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

/** Normalize whitespace/trailing noise so two tool_result blocks hash-compare cleanly. */
function dedupKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Walk messages looking for duplicate tool_result content blocks. First
 * occurrence keeps its content; later occurrences get replaced with a
 * short back-reference. This is the biggest win when an agent reads the
 * same file twice in one loop.
 */
export function dedupeToolResults(messages: ChatMessage[]): { messages: ChatMessage[]; saved: number } {
  const seen = new Map<string, number>();
  let saved = 0;
  const out: ChatMessage[] = messages.map((m) => {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) return m;

    const newBlocks: ContentBlock[] = m.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const result = block as ToolResultContentBlock;
      if (typeof result.content !== 'string' || result.content.length < 200) return block;

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

/** Apply truncation to every tool_result block in-place. */
export function truncateAllToolResults(
  messages: ChatMessage[],
  maxTokens: number,
): { messages: ChatMessage[]; saved: number } {
  let saved = 0;
  const out: ChatMessage[] = messages.map((m) => {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) return m;
    const newBlocks: ContentBlock[] = m.content.map((block) => {
      if (block.type !== 'tool_result') return block;
      const result = block as ToolResultContentBlock;
      if (typeof result.content !== 'string') return block;
      const { text, saved: s } = truncateToolResult(result.content, maxTokens);
      if (s === 0) return block;
      saved += s;
      return { ...result, content: text } satisfies ToolResultContentBlock;
    });
    return { ...m, content: newBlocks };
  });
  return { messages: out, saved };
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
      stats: { truncatedBytes: 0, dedupedBytes: 0, whitespaceBytes: 0 },
    };
  }

  const sys = collapseWhitespace(systemPrompt);
  const truncated = truncateAllToolResults(messages, opts.maxToolResultTokens);
  const deduped = dedupeToolResults(truncated.messages);

  return {
    systemPrompt: sys.text,
    messages: deduped.messages,
    stats: {
      truncatedBytes: truncated.saved,
      dedupedBytes: deduped.saved,
      whitespaceBytes: sys.saved,
    },
  };
}
