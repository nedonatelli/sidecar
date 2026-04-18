import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for compression.ts (v0.65 chunk 2b — loop helper hardening).
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

import { compressMessages, applyBudgetCompression, maybeCompressPostTool } from './compression.js';
import type { ChatMessage, ContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { LoopState } from './state.js';

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: undefined,
    changelog: undefined,
    mcpManager: undefined,
    messages: [],
    iteration: 1,
    totalChars: 0,
    recentToolCalls: [],
    autoFixRetriesByFile: new Map(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map(),
    criticInjectionsByTestHash: new Map(),
    toolCallCounts: new Map(),
    gateState: {} as LoopState['gateState'],
    ...overrides,
  };
}

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

describe('maybeCompressPostTool', () => {
  it('is a no-op when totalChars is below the compression threshold', () => {
    const info = vi.fn();
    const state = stubState({
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
    const state = stubState({
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
    const state = stubState({ maxTokens: 100_000, totalChars: 100 });
    const client = {} as SideCarClient;
    const outcome = await applyBudgetCompression(client, state);
    expect(outcome).toBe('ok');
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it('invokes the summarizer + compressMessages when over the threshold and returns "ok" when back under budget', async () => {
    makeSummarizerMock({ freedChars: 100_000, turnsSummarized: 3, turnsCount: 5, messages: [] });
    const info = vi.fn();
    const state = stubState({
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

  it('returns "exhausted" when compaction cannot bring totalChars below maxTokens × CHARS_PER_TOKEN', async () => {
    makeSummarizerMock({ freedChars: 0 });
    const state = stubState({
      maxTokens: 100_000,
      totalChars: 500_000, // stays above 100K tokens × 4 after 0-freed compaction
    });
    const outcome = await applyBudgetCompression({} as SideCarClient, state);
    expect(outcome).toBe('exhausted');
  });

  it('does not splice state.messages when the summarizer freed 0 chars', async () => {
    makeSummarizerMock({ freedChars: 0, messages: [{ role: 'user', content: 'replacement' }] });
    const original: ChatMessage[] = [{ role: 'user', content: 'original' }];
    const state = stubState({
      maxTokens: 100_000,
      totalChars: 300_000,
      messages: original,
    });
    await applyBudgetCompression({} as SideCarClient, state);
    expect(state.messages).toBe(original);
    expect(state.messages[0].content).toBe('original');
  });
});
