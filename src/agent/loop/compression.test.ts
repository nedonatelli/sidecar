import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubLoopState } from './testHelpers.js';
import type { EpisodicMemoryStore } from '../episodicMemory.js';

// ---------------------------------------------------------------------------
// Tests for compression.ts (loop helper hardening).
//
// Three exports:
//   - compressMessages — truncates oversize tool_result bodies + drops
//     old standalone thinking blocks (preserves thinking that precedes
//     tool_use so Anthropic's signed-thinking pairing stays intact).
//   - applyBudgetCompression — pre-turn: runs summarizer + compressMessages
//     when estimated tokens > 70% of budget. Returns 'exhausted' if still
//     over budget after compaction.
//   - maybeCompressPostTool — mid-turn: only runs compressMessages.
// ---------------------------------------------------------------------------

// Shared reference the tests reconfigure via `mockSummarize.mockResolvedValueOnce(...)`.
// The class mock below delegates into this vi.fn so each test can script
// its own summarize() return without re-declaring the mock.
const { mockSummarize } = vi.hoisted(() => ({ mockSummarize: vi.fn() }));

vi.mock('../conversationSummarizer.js', () => ({
  ConversationSummarizer: class {
    constructor(_client: unknown) {
      void _client;
    }
    summarize(...args: unknown[]) {
      return mockSummarize(...args);
    }
  },
}));
vi.mock('../toolResultCompressor.js', () => {
  // `new ToolResultCompressor()` — needs to be a real constructor, not
  // an arrow-returning mockImplementation. Define as a class so the
  // `new` invocation inside compressMessages works.
  return {
    ToolResultCompressor: class {
      compress(content: string, maxLen: number) {
        return {
          content: content.length > maxLen ? content.slice(0, maxLen) + '…' : content,
        };
      }
    },
  };
});

import {
  compressMessages,
  applyBudgetCompression,
  maybeCompressPostTool,
  clearCompressionCache,
} from './compression.js';
import type { ChatMessage, ContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { LoopState } from './state.js';

function toolResultBlock(content: string): ContentBlock {
  return { type: 'tool_result', tool_use_id: 'tu1', content, is_error: false };
}

function thinkingBlock(thinking: string): ContentBlock {
  return { type: 'thinking', thinking, signature: 'sig' } as unknown as ContentBlock;
}

function toolUseBlock(): ContentBlock {
  return { type: 'tool_use', id: 'tu1', name: 'read_file', input: {} } as unknown as ContentBlock;
}

beforeEach(() => {
  mockSummarize.mockReset();
});

describe('compressMessages', () => {
  it('leaves the last 2 messages untouched regardless of tool_result size', () => {
    const longContent = 'x'.repeat(2000);
    const messages: ChatMessage[] = [
      { role: 'user', content: [toolResultBlock(longContent)] }, // distFromEnd = 1
      { role: 'user', content: [toolResultBlock(longContent)] }, // distFromEnd = 0
    ];
    const freed = compressMessages(messages);
    expect(freed).toBe(0);
    const firstContent = messages[0].content as ContentBlock[];
    expect((firstContent[0] as { content: string }).content).toHaveLength(2000);
  });

  it('compresses tool_result to ≤1000 chars when 2-5 positions from the end', () => {
    const longContent = 'x'.repeat(2000);
    const messages: ChatMessage[] = [];
    // 7 messages; the FIRST (index 0, distFromEnd=6) gets the <200 rule.
    // Indices 1-4 (distFromEnd 5-2) get the 1000-char rule.
    for (let i = 0; i < 7; i++) {
      messages.push({ role: 'user', content: [toolResultBlock(longContent)] });
    }
    const freed = compressMessages(messages);
    // distFromEnd=6 hits the <200 rule (200 chars kept)
    const deep = (messages[0].content as ContentBlock[])[0] as { content: string };
    expect(deep.content.length).toBeLessThanOrEqual(201); // '…' adds 1 char
    // distFromEnd=5..2 hits the 1000 rule
    const mid = (messages[3].content as ContentBlock[])[0] as { content: string };
    expect(mid.content.length).toBeLessThanOrEqual(1001);
    expect(freed).toBeGreaterThan(0);
  });

  it('leaves tool_result untouched when already below the max', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: [toolResultBlock('short content')] });
    }
    const freed = compressMessages(messages);
    expect(freed).toBe(0);
  });

  it('drops standalone thinking blocks when ≥8 from the end', () => {
    const messages: ChatMessage[] = [];
    // 10 messages — the first (index 0, distFromEnd=9) qualifies for drop.
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: 'assistant',
        content: i === 0 ? [thinkingBlock('a'.repeat(500))] : [{ type: 'text', text: 'x' }],
      });
    }
    const freed = compressMessages(messages);
    expect(freed).toBeGreaterThan(0);
    // Thinking block no longer present in the first message.
    expect(messages[0].content).toEqual([]);
  });

  it('TRUNCATES (does not drop) thinking blocks paired with a tool_use in the same message', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: i === 0 ? 'assistant' : 'user',
        content: i === 0 ? [thinkingBlock('a'.repeat(500)), toolUseBlock()] : [{ type: 'text', text: 'x' }],
      });
    }
    compressMessages(messages);
    const firstContent = messages[0].content as ContentBlock[];
    const thinkingBlockOut = firstContent.find((b) => b.type === 'thinking') as { thinking: string } | undefined;
    expect(thinkingBlockOut).toBeDefined();
    expect(thinkingBlockOut!.thinking.length).toBeLessThanOrEqual(220); // 200 + "… (truncated)" suffix
    // tool_use is still present.
    expect(firstContent.some((b) => b.type === 'tool_use')).toBe(true);
  });

  it('string-content messages are untouched (compression only runs on block arrays)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'plain string' },
      { role: 'user', content: 'another' },
      { role: 'user', content: 'still text' },
    ];
    compressMessages(messages);
    expect(messages[0].content).toBe('plain string');
  });
});

// ---------------------------------------------------------------------------
// Semantic tier routing tests.
//
// These require an assistant message with a tool_use block so buildToolNameMap
// can resolve the tool_use_id → tool name and route to the correct tier.
// ---------------------------------------------------------------------------
describe('compressMessages — semantic tiers', () => {
  const LONG = 'x'.repeat(2000);

  /**
   * Build a message list:
   *   [assistant(tool_use name), user(tool_result id), ...distFromEnd padding]
   *
   * The tool_result ends up at index 1, so its distFromEnd equals the number
   * of padding messages appended.
   */
  function buildMessages(toolName: string, resultContent: string, distFromEnd: number, isError = false): ChatMessage[] {
    const id = `tu-${toolName}`;
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: toolName, input: {} } as ContentBlock],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: resultContent, is_error: isError }],
      },
    ];
    for (let i = 0; i < distFromEnd; i++) {
      msgs.push({ role: 'assistant', content: 'pad' });
    }
    return msgs;
  }

  function resultContent(msgs: ChatMessage[], index: number): string {
    return ((msgs[index].content as ContentBlock[])[0] as { content: string }).content;
  }

  it('error tier: is_error=true result is never compressed at any distance', () => {
    const msgs = buildMessages('run_command', LONG, 20, true);
    compressMessages(msgs);
    expect(resultContent(msgs, 1)).toHaveLength(2000);
  });

  it('error tier: is_error=true overrides write tool classification', () => {
    const msgs = buildMessages('write_file', LONG, 20, true);
    compressMessages(msgs);
    expect(resultContent(msgs, 1)).toHaveLength(2000);
  });

  it('write tier: result is preserved when distFromEnd < 6', () => {
    const msgs = buildMessages('write_file', LONG, 4); // distFromEnd = 4
    compressMessages(msgs);
    expect(resultContent(msgs, 1)).toHaveLength(2000);
  });

  it('write tier: result is preserved at the boundary (distFromEnd = 5)', () => {
    const msgs = buildMessages('edit_file', LONG, 5); // distFromEnd = 5
    compressMessages(msgs);
    expect(resultContent(msgs, 1)).toHaveLength(2000);
  });

  it('write tier: compressed to ≤1000 chars when 6 ≤ distFromEnd < 12', () => {
    const msgs = buildMessages('write_file', LONG, 7); // distFromEnd = 7
    compressMessages(msgs);
    expect(resultContent(msgs, 1).length).toBeLessThanOrEqual(1001);
  });

  it('write tier: compressed to ≤200 chars when distFromEnd ≥ 12', () => {
    const msgs = buildMessages('git_commit', LONG, 15); // distFromEnd = 15
    compressMessages(msgs);
    expect(resultContent(msgs, 1).length).toBeLessThanOrEqual(201);
  });

  it('read tier: compressed to ≤500 chars when 1 ≤ distFromEnd < 5', () => {
    const msgs = buildMessages('read_file', LONG, 2); // distFromEnd = 2
    compressMessages(msgs);
    expect(resultContent(msgs, 1).length).toBeLessThanOrEqual(501);
  });

  it('read tier: compressed to ≤150 chars when distFromEnd ≥ 5', () => {
    const msgs = buildMessages('git_diff', LONG, 6); // distFromEnd = 6
    compressMessages(msgs);
    expect(resultContent(msgs, 1).length).toBeLessThanOrEqual(151);
  });

  it('read tier: compressed from distFromEnd = 1 (more aggressive than other tier)', () => {
    // read is compressed at distFromEnd=1; 'other' tier preserves at distFromEnd<2
    const readMsgs = buildMessages('web_search', LONG, 1);
    const otherMsgs = buildMessages('run_tests', LONG, 1);
    compressMessages(readMsgs);
    compressMessages(otherMsgs);
    expect(resultContent(readMsgs, 1).length).toBeLessThanOrEqual(501); // compressed
    expect(resultContent(otherMsgs, 1)).toHaveLength(2000); // preserved
  });

  it('other tier: result is preserved when distFromEnd < 2', () => {
    const msgs = buildMessages('run_tests', LONG, 1); // distFromEnd = 1, unrecognised tool
    compressMessages(msgs);
    expect(resultContent(msgs, 1)).toHaveLength(2000);
  });

  it('buildToolNameMap: resolves names from non-adjacent messages in the same history', () => {
    // Two tool call pairs with different names; both far enough from end to compress.
    // write_file at distFromEnd=6 → 1000-char limit
    // read_file at distFromEnd=4 → 500-char limit (read tier)
    const writeId = 'tu-write';
    const readId = 'tu-read';
    const msgs: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: writeId, name: 'write_file', input: {} } as ContentBlock],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: writeId, content: LONG, is_error: false }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: readId, name: 'read_file', input: {} } as ContentBlock] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: readId, content: LONG, is_error: false }] },
      // 4 padding → len=8; writeResult distFromEnd=6, readResult distFromEnd=4
      { role: 'assistant', content: 'pad' },
      { role: 'assistant', content: 'pad' },
      { role: 'assistant', content: 'pad' },
      { role: 'assistant', content: 'pad' },
    ];
    compressMessages(msgs);
    const writeLen = resultContent(msgs, 1).length;
    const readLen = resultContent(msgs, 3).length;
    expect(writeLen).toBeLessThanOrEqual(1001); // write tier
    expect(readLen).toBeLessThanOrEqual(501); // read tier
    // read is compressed harder than write at these distances
    expect(readLen).toBeLessThan(writeLen);
  });
});

describe('maybeCompressPostTool', () => {
  it('is a no-op when totalChars is below the compression threshold', () => {
    const info = vi.fn();
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 100,
      logger: { info, warn: vi.fn() } as unknown as LoopState['logger'],
    });
    maybeCompressPostTool(state);
    expect(info).not.toHaveBeenCalled();
    expect(state.totalChars).toBe(100);
  });

  it('runs compressMessages when totalChars exceeds 70% of maxTokens (in chars)', () => {
    // 70% of 100K tokens = 70K tokens; CHARS_PER_TOKEN=4 → 280K chars.
    // Seed totalChars = 300K with a message carrying an oversize tool_result
    // that's 6+ from the end so compressMessages has something to free.
    const messages: ChatMessage[] = [];
    const long = 'y'.repeat(5000);
    for (let i = 0; i < 8; i++) {
      messages.push({ role: 'user', content: [toolResultBlock(long)] });
    }
    const info = vi.fn();
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 300_000,
      messages,
      logger: { info, warn: vi.fn() } as unknown as LoopState['logger'],
    });
    // logger is readonly on LoopState — pass it via stubState overrides
    // (the above does this already). No post-hoc assignment needed.
    maybeCompressPostTool(state);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('Post-tool compression');
    expect(state.totalChars).toBeLessThan(300_000);
  });
});

describe('applyBudgetCompression', () => {
  function makeSummarizerMock(outcome: {
    freedChars: number;
    turnsSummarized?: number;
    turnsCount?: number;
    messages?: ChatMessage[];
  }) {
    mockSummarize.mockResolvedValueOnce({
      freedChars: outcome.freedChars,
      messages: outcome.messages ?? [],
      metadata: {
        turnsSummarized: outcome.turnsSummarized ?? 0,
        turnsCount: outcome.turnsCount ?? 0,
      },
    });
  }

  it('returns "ok" without invoking the summarizer when below the threshold', async () => {
    const state = stubLoopState({ maxTokens: 100_000, totalChars: 100 });
    const client = {} as SideCarClient;
    const outcome = await applyBudgetCompression(client, state);
    expect(outcome).toBe('ok');
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it('invokes the summarizer + compressMessages when over the threshold and returns "ok" when back under budget', async () => {
    makeSummarizerMock({ freedChars: 100_000, turnsSummarized: 3, turnsCount: 5, messages: [] });
    const info = vi.fn();
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 300_000, // above 70% of 100K tokens × 4 chars = 280K
      logger: { info, warn: vi.fn() } as unknown as LoopState['logger'],
    });
    const outcome = await applyBudgetCompression({} as SideCarClient, state);
    expect(outcome).toBe('ok');
    expect(mockSummarize).toHaveBeenCalledOnce();
    expect(state.totalChars).toBe(200_000); // 300K - 100K freed
    expect(info).toHaveBeenCalled();
  });

  it('returns "ok" even when episodic memory add() rejects (failure is swallowed, not propagated)', async () => {
    makeSummarizerMock({
      freedChars: 100_000,
      turnsSummarized: 2,
      turnsCount: 4,
      messages: [{ role: 'assistant', content: 'summary text' }],
    });
    const faultyEpisodic = {
      add: vi.fn().mockRejectedValue(new Error('embedding model failed to load')),
      persist: vi.fn().mockResolvedValue(undefined),
    } as unknown as EpisodicMemoryStore;
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 300_000,
      episodicMemory: faultyEpisodic,
    });

    const outcome = await applyBudgetCompression({} as SideCarClient, state);

    expect(outcome).toBe('ok');
    expect(faultyEpisodic.add).toHaveBeenCalledOnce();
  });

  it('returns "exhausted" when compaction cannot bring totalChars below maxTokens × CHARS_PER_TOKEN', async () => {
    makeSummarizerMock({ freedChars: 0 });
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 500_000, // stays above 100K tokens × 4 after 0-freed compaction
    });
    const outcome = await applyBudgetCompression({} as SideCarClient, state);
    expect(outcome).toBe('exhausted');
  });

  it('does not splice state.messages when the summarizer freed 0 chars', async () => {
    makeSummarizerMock({ freedChars: 0, messages: [{ role: 'user', content: 'replacement' }] });
    const original: ChatMessage[] = [{ role: 'user', content: 'original' }];
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 300_000,
      messages: original,
    });
    await applyBudgetCompression({} as SideCarClient, state);
    expect(state.messages).toBe(original);
    expect(state.messages[0].content).toBe('original');
  });

  it('uses lastActualInputTokens when available instead of char estimate', async () => {
    // Below the threshold via char estimate alone (50K/4 = 12.5K << 70K threshold)
    // but above via actual tokens (80K > 70K). Should trigger compression.
    makeSummarizerMock({ freedChars: 10_000, messages: [], turnsSummarized: 1, turnsCount: 3 });
    const state = stubLoopState({
      maxTokens: 100_000,
      totalChars: 50_000,
      lastActualInputTokens: 80_000, // above 70% of 100K
    });
    const outcome = await applyBudgetCompression({} as SideCarClient, state);
    expect(mockSummarize).toHaveBeenCalledOnce();
    expect(outcome).toBe('ok');
    // After compression, lastActualInputTokens should be reset
    expect(state.lastActualInputTokens).toBeUndefined();
  });
});

describe('compressMessages — image bypass', () => {
  function imageBlock(dataLength = 50_000): ContentBlock {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'x'.repeat(dataLength),
      },
    } as ContentBlock;
  }

  it('replaces image blocks with a text placeholder at heavy compression tier (≥6 from end)', () => {
    const messages: ChatMessage[] = [];
    // 8 messages so the first has distFromEnd = 7 (heavy tier)
    for (let i = 0; i < 7; i++) messages.push({ role: 'user', content: 'short' });
    messages.unshift({ role: 'user', content: [imageBlock(40_000)] });

    const freed = compressMessages(messages);
    expect(freed).toBeGreaterThan(0);

    const replaced = messages[0].content as ContentBlock[];
    expect(replaced[0].type).toBe('text');
    expect((replaced[0] as { type: 'text'; text: string }).text).toContain('image/jpeg');
    expect((replaced[0] as { type: 'text'; text: string }).text).toContain('dropped for context budget');
  });

  it('preserves image blocks in the light compression tier (2-5 from end)', () => {
    const messages: ChatMessage[] = [];
    // 4 messages: image is at distFromEnd = 3 (light tier — preserved)
    for (let i = 0; i < 3; i++) messages.push({ role: 'user', content: 'short' });
    messages.unshift({ role: 'user', content: [imageBlock(40_000)] });

    compressMessages(messages);

    const preserved = messages[0].content as ContentBlock[];
    expect(preserved[0].type).toBe('image');
  });

  it('preserves image blocks in the last 2 messages (untouched tier)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [imageBlock(40_000)] }, // distFromEnd = 1
      { role: 'assistant', content: 'response' }, // distFromEnd = 0
    ];
    compressMessages(messages);
    const preserved = messages[0].content as ContentBlock[];
    expect(preserved[0].type).toBe('image');
  });
});

describe('compression cache', () => {
  beforeEach(() => clearCompressionCache());

  it('returns the same compressed string for identical content without re-compressing', () => {
    const body = 'x'.repeat(5000);
    const messages = (): ChatMessage[] => [
      { role: 'user', content: [toolResultBlock(body)] },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: [toolResultBlock(body)] },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: [toolResultBlock(body)] },
      { role: 'assistant', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'assistant', content: 'e' },
    ];

    const first = messages();
    compressMessages(first);
    const firstResult = (first[0].content as ContentBlock[])[0] as { content: string };

    const second = messages();
    compressMessages(second);
    const secondResult = (second[0].content as ContentBlock[])[0] as { content: string };

    expect(firstResult.content).toBe(secondResult.content);
  });

  it('clearCompressionCache removes cached entries', () => {
    const body = 'y'.repeat(5000);
    const make = (): ChatMessage[] => [
      { role: 'user', content: [toolResultBlock(body)] },
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'assistant', content: 'e' },
      { role: 'assistant', content: 'f' },
      { role: 'assistant', content: 'g' },
    ];
    compressMessages(make());
    clearCompressionCache();
    // After clear, a fresh call should still produce the correct compressed output
    const msgs = make();
    compressMessages(msgs);
    const result = (msgs[0].content as ContentBlock[])[0] as { content: string };
    expect(result.content.length).toBeLessThan(body.length);
  });
});
