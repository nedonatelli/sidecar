/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConversationSummarizer } from './conversationSummarizer.js';
import type { ChatMessage } from '../ollama/types.js';

/**
 * Mock SideCarClient for testing
 */
const createMockClient = (summaryText = 'Turn 1: explored files. Turn 2: fixed errors.') => ({
  complete: vi.fn(async () => summaryText),
  streamChat: vi.fn(),
  updateSystemPrompt: vi.fn(),
  getModel: vi.fn(() => 'mock-model'),
  // Phase 4b.3 wiring: summarizeTurns consults the router before each
  // dispatch. Tests that don't exercise routing return null to take
  // the no-op branch.
  routeForDispatch: vi.fn(() => null),
});

describe('ConversationSummarizer', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let summarizer: ConversationSummarizer;

  beforeEach(() => {
    mockClient = createMockClient();
    summarizer = new ConversationSummarizer(mockClient as any);
  });

  describe('basic summarization', () => {
    it('returns unchanged messages when there are too few turns', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];

      const result = await summarizer.summarize(messages, { keepRecentTurns: 4 });

      expect(result.messages).toEqual(messages);
      expect(result.freedChars).toBe(0);
      expect(result.metadata.turnsSummarized).toBe(0);
    });

    it('respects keepRecentTurns option', async () => {
      const messages: ChatMessage[] = [];

      // Create 6 turns (12 messages) with enough content to trigger summarization
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'user', content: `Query ${i}. `.repeat(20) });
        messages.push({
          role: 'assistant',
          content: `Response ${i}. This is a longer response to add some content.`.repeat(5),
        });
      }

      const result = await summarizer.summarize(messages, { keepRecentTurns: 2, minCharsToSave: 100 });

      // Should summarize turns 0–3, keep turns 4–5
      expect(result.metadata.turnsSummarized).toBe(4);
      // Result should have: summary message + messages from turns 4–5
      expect(result.freedChars).toBeGreaterThan(0);
    });

    it('returns unchanged messages if old turns are too small', async () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'short' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'ok' },
        { role: 'assistant', content: 'done' },
      ];

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 0,
        minCharsToSave: 100000, // Very high threshold
      });

      expect(result.freedChars).toBe(0);
      expect(result.metadata.turnsSummarized).toBe(0);
    });

    it('generates summary and includes it at the start', async () => {
      const messages: ChatMessage[] = [];

      // Create 5 turns
      for (let i = 0; i < 5; i++) {
        messages.push({
          role: 'user',
          content: `Query ${i}. This is a longer query to ensure we have enough content to summarize.`,
        });
        messages.push({
          role: 'assistant',
          content: `Response ${i}. This is a longer response with more content to reach our minimum savings threshold.`,
        });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 100,
      });

      expect(result.metadata.turnsSummarized).toBeGreaterThan(0);

      // First message should be a summary
      const firstMsg = result.messages[0];
      expect(firstMsg.role).toBe('user');
      expect(typeof firstMsg.content).toBe('string');
      expect((firstMsg.content as string).includes('summary')).toBe(true);
    });

    it('tags the summarize dispatch with role=summarize for the router (v0.64 phase 4b.3)', async () => {
      // Mirror the "generates summary" test above — content lengths are
      // tuned to pass the minCharsToSave threshold so the summarizer
      // actually dispatches and the router tag can be observed.
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push({
          role: 'user',
          content: `Query ${i}. This is a longer query to ensure we have enough content to summarize.`,
        });
        messages.push({
          role: 'assistant',
          content: `Response ${i}. This is a longer response with more content to reach our minimum savings threshold.`,
        });
      }
      // Force the LLM compress path by setting a tight maxSummaryLength
      // so the deterministic fast path (structured fits in maxLength)
      // doesn't short-circuit the dispatch.
      await summarizer.summarize(messages, { keepRecentTurns: 1, minCharsToSave: 100, maxSummaryLength: 150 });
      const routeCalls = (mockClient.routeForDispatch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(routeCalls.length).toBeGreaterThan(0);
      expect(routeCalls[0][0]).toMatchObject({ role: 'summarize' });
    });
  });

  describe('turn splitting', () => {
    it('correctly identifies turn boundaries', async () => {
      const messages: ChatMessage[] = [];

      // Create 4 turns (12+ messages) to pass the minimum threshold
      for (let i = 0; i < 4; i++) {
        messages.push({ role: 'user', content: 'Q'.repeat(30) });
        messages.push({ role: 'assistant', content: 'A'.repeat(30) });
        messages.push({ role: 'assistant', content: 'A continued'.repeat(15) });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 50,
      });

      // Should have 3 turns summarized (4 - 1 kept)
      expect(result.metadata.turnsSummarized).toBeGreaterThanOrEqual(1);
    });
  });

  describe('content blocks handling', () => {
    it('handles text content blocks', async () => {
      const messages: ChatMessage[] = [];

      // Create 4 turns with content blocks (12+ messages)
      for (let i = 0; i < 4; i++) {
        messages.push({ role: 'user', content: 'hello '.repeat(20) });
        messages.push({
          role: 'assistant',
          content: [{ type: 'text' as const, text: 'Hello from block '.repeat(20) }],
        });
        messages.push({
          role: 'assistant',
          content: [{ type: 'text' as const, text: 'More text '.repeat(15) }],
        });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 50,
      });

      expect(result.metadata.turnsSummarized).toBeGreaterThanOrEqual(1);
    });

    it('handles mixed content blocks', async () => {
      const messages: ChatMessage[] = [];

      // Create 4 turns with mixed blocks (12+ messages)
      for (let i = 0; i < 4; i++) {
        messages.push({ role: 'user', content: 'query '.repeat(25) });
        messages.push({
          role: 'assistant',
          content: [
            { type: 'text' as const, text: 'Response'.repeat(15) },
            { type: 'thinking' as const, thinking: 'Reasoning'.repeat(15) },
          ],
        });
        messages.push({
          role: 'assistant',
          content: [{ type: 'text' as const, text: 'More '.repeat(20) }],
        });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 50,
      });

      expect(result.metadata.turnsSummarized).toBeGreaterThanOrEqual(1);
    });
  });

  describe('error handling', () => {
    it('returns original messages if summarization fails', async () => {
      const mockFailingClient = createMockClient();
      mockFailingClient.complete = vi.fn(async () => {
        throw new Error('API failure');
      });

      const summarizer2 = new ConversationSummarizer(mockFailingClient as any);

      const messages: ChatMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push({
          role: 'user',
          content: `This is query number ${i} with some additional content to make it longer.`,
        });
        messages.push({
          role: 'assistant',
          content: `This is response number ${i} with some additional content to make it longer.`,
        });
      }

      const result = await summarizer2.summarize(messages, {
        keepRecentTurns: 2,
        minCharsToSave: 100,
      });

      // Should still return something (either original or partially compressed)
      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);
    });

    it('handles summarization timeout gracefully', async () => {
      const mockSlowClient = createMockClient();
      mockSlowClient.complete = vi.fn(
        () =>
          new Promise(() => {
            // Never resolves
          }),
      );

      const summarizer2 = new ConversationSummarizer(mockSlowClient as any);

      const messages: ChatMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push({
          role: 'user',
          content: `Query ${i} with content`.repeat(5),
        });
        messages.push({
          role: 'assistant',
          content: `Response ${i} with content`.repeat(5),
        });
      }

      // Should timeout and fall back gracefully
      const resultPromise = summarizer2.summarize(messages, {
        keepRecentTurns: 2,
        minCharsToSave: 100,
        summaryTimeoutMs: 100, // Very short timeout
      });

      const result = await resultPromise;
      expect(result.messages).toBeDefined();
    });
  });

  describe('character accounting', () => {
    it('accurately reports freed characters', async () => {
      const messages: ChatMessage[] = [];

      // Create turns with measurable content
      for (let i = 0; i < 4; i++) {
        messages.push({ role: 'user', content: 'Q'.repeat(100) });
        messages.push({ role: 'assistant', content: 'A'.repeat(100) });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 10,
      });

      // Should have freed some characters
      if (result.metadata.turnsSummarized > 0) {
        expect(result.freedChars).toBeGreaterThan(0);
        expect(result.freedChars).toBeLessThan(1000); // Not more than original
      }
    });

    it('never reports negative freed characters', async () => {
      const messages: ChatMessage[] = [];

      for (let i = 0; i < 5; i++) {
        messages.push({ role: 'user', content: `Query ${i}` });
        messages.push({ role: 'assistant', content: `Response ${i}` });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 1,
      });

      expect(result.freedChars).toBeGreaterThanOrEqual(0);
    });
  });

  describe('metadata accuracy', () => {
    it('reports correct turn counts', async () => {
      const messages: ChatMessage[] = [];

      // 5 turns = 10 messages
      for (let i = 0; i < 5; i++) {
        messages.push({ role: 'user', content: `Q${i}` });
        messages.push({ role: 'assistant', content: `A${i}` });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 2,
        minCharsToSave: 1,
      });

      expect(result.metadata.turnsCount).toBe(5);
      expect(result.metadata.turnsSummarized).toBe(3); // 5 - 2
    });

    it('summary length is within maxSummaryLength', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: 'user', content: `Query ${i}` });
        messages.push({ role: 'assistant', content: `Response ${i}` });
      }

      const maxLen = 200;
      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 1,
        maxSummaryLength: maxLen,
      });

      expect(result.metadata.summaryLength).toBeLessThanOrEqual(maxLen);
    });
  });

  describe('per-turn cap', () => {
    it('bounds each assembled fact line to maxCharsPerTurn so factsSummary fits without an LLM call', async () => {
      // Huge queries + huge replies — without a per-turn cap, facts would
      // overflow maxSummaryLength and force an LLM round-trip. With the cap,
      // each "Turn N: ..." line stays under the cap and the mocked client
      // should never be asked to compress further.
      const bigQuery = 'X'.repeat(2000);
      const bigReply = 'Y'.repeat(2000);
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: bigQuery });
        messages.push({ role: 'assistant', content: bigReply });
      }

      // Spy on the mock client's complete() to assert it wasn't called.
      mockClient.complete.mockClear();

      const maxCharsPerTurn = 100;
      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 1,
        maxSummaryLength: 5000, // well above 8 * 100
        maxCharsPerTurn,
      });

      // With 7 old turns × 100 chars/turn = ~700 chars, the facts string
      // fits within maxSummaryLength and the LLM path is skipped entirely.
      expect(mockClient.complete).not.toHaveBeenCalled();

      // Summary lines are all bounded by maxCharsPerTurn. Fact lines now
      // carry a bullet prefix ("- Turn N: ..."), so we strip it before
      // checking against the per-turn cap.
      const summary = result.messages[0].content as string;
      const factLines = summary.split('\n').filter((line) => /^- Turn /.test(line));
      expect(factLines.length).toBeGreaterThan(0);
      for (const line of factLines) {
        const withoutBullet = line.replace(/^- /, '');
        expect(withoutBullet.length).toBeLessThanOrEqual(maxCharsPerTurn);
      }
    });

    it('defaults to DEFAULT_MAX_CHARS_PER_TURN when caller omits the option', async () => {
      const bigQuery = 'Q'.repeat(2000);
      const bigReply = 'R'.repeat(2000);
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: bigQuery });
        messages.push({ role: 'assistant', content: bigReply });
      }

      mockClient.complete.mockClear();
      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 1,
        maxSummaryLength: 5000,
      });

      // Default 220 chars/turn × 7 turns = ~1540 < 5000, so LLM not needed.
      expect(mockClient.complete).not.toHaveBeenCalled();
      const summary = result.messages[0].content as string;
      const factLines = summary.split('\n').filter((line) => /^- Turn /.test(line));
      for (const line of factLines) {
        const withoutBullet = line.replace(/^- /, '');
        expect(withoutBullet.length).toBeLessThanOrEqual(220);
      }
    });
  });

  describe('structured output format', () => {
    it('emits a ## Facts established header with bulleted turn lines', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'user', content: `Query ${i}. `.repeat(10) });
        messages.push({ role: 'assistant', content: `Reply ${i}. `.repeat(10) });
      }

      const result = await summarizer.summarize(messages, { keepRecentTurns: 1, minCharsToSave: 50 });
      const summary = result.messages[0].content as string;

      expect(summary).toMatch(/^\[Earlier conversation summary/);
      expect(summary).toContain('## Facts established');
      // Every fact line is a bullet.
      const factLines = summary.split('\n').filter((l) => /^- Turn /.test(l));
      expect(factLines.length).toBeGreaterThan(0);
    });

    it('includes a ## Code changes section when tool_use blocks write files', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 5; i++) {
        messages.push({
          role: 'user',
          content: `Task ${i} that needs enough prose to clear the min-chars-to-save gate`,
        });
        messages.push({
          role: 'assistant',
          content: [
            { type: 'text' as const, text: `Working on task ${i}` },
            {
              type: 'tool_use' as const,
              id: `t${i}`,
              name: 'write_file',
              input: { path: `src/file${i}.ts`, content: 'x' },
            },
          ],
        });
      }

      const result = await summarizer.summarize(messages, { keepRecentTurns: 1, minCharsToSave: 50 });
      const summary = result.messages[0].content as string;

      expect(summary).toContain('## Code changes');
      expect(summary).toContain('`src/file0.ts` (write_file)');
      expect(summary).toContain('`src/file3.ts` (write_file)');
    });

    it('deduplicates code changes by path, keeping the last tool that touched it', async () => {
      const messages: ChatMessage[] = [];
      // Enough early-turn content to clear minCharsToSave.
      for (let i = 0; i < 3; i++) {
        messages.push({
          role: 'user',
          content: `Setup turn ${i} with prose that adds to the accumulated character count`.repeat(3),
        });
        messages.push({ role: 'assistant', content: `Reply ${i}`.repeat(3) });
      }
      // Now the file gets touched: first written, then edited, then deleted.
      messages.push({ role: 'user', content: 'Do three operations on the same file' });
      messages.push({
        role: 'assistant',
        content: [
          { type: 'tool_use' as const, id: 'a', name: 'write_file', input: { path: 'src/x.ts', content: 'v1' } },
          {
            type: 'tool_use' as const,
            id: 'b',
            name: 'edit_file',
            input: { path: 'src/x.ts', search: 'v1', replace: 'v2' },
          },
          { type: 'tool_use' as const, id: 'c', name: 'delete_file', input: { path: 'src/x.ts' } },
        ],
      });
      // One kept turn so old turns include the tool_use block above.
      messages.push({ role: 'user', content: 'next' });
      messages.push({ role: 'assistant', content: 'ok' });

      const result = await summarizer.summarize(messages, { keepRecentTurns: 1, minCharsToSave: 50 });
      const summary = result.messages[0].content as string;

      expect(summary).toContain('## Code changes');
      // Only one entry for src/x.ts, tagged with the last-seen tool (delete_file).
      const matches = summary.match(/`src\/x\.ts`/g) ?? [];
      expect(matches).toHaveLength(1);
      expect(summary).toContain('`src/x.ts` (delete_file)');
    });

    it('omits the ## Code changes section when no file-mutation tool_use blocks were seen', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push({ role: 'user', content: `Explain ${i}. `.repeat(10) });
        messages.push({ role: 'assistant', content: `Explanation ${i}. `.repeat(10) });
      }

      const result = await summarizer.summarize(messages, { keepRecentTurns: 1, minCharsToSave: 50 });
      const summary = result.messages[0].content as string;

      expect(summary).toContain('## Facts established');
      expect(summary).not.toContain('## Code changes');
    });

    it('falls back to the deterministic structured form when the LLM ignores the schema', async () => {
      // Force the LLM path with tight maxSummaryLength relative to fact count.
      const bigQuery = 'Q'.repeat(500);
      const bigReply = 'R'.repeat(500);
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push({ role: 'user', content: bigQuery });
        messages.push({ role: 'assistant', content: bigReply });
      }

      // LLM returns freeform prose with no ## Facts established header.
      mockClient.complete.mockResolvedValueOnce('Just some prose without any section headers at all.');

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 50,
        maxSummaryLength: 400, // tight, forces LLM path
        maxCharsPerTurn: 200,
      });
      const summary = result.messages[0].content as string;

      // Deterministic fallback kicked in — the structured header must be present.
      expect(summary).toContain('## Facts established');
    });
  });

  describe('integration with real-like scenarios', () => {
    it('handles agent loop scenario (many turns with tool results)', async () => {
      const messages: ChatMessage[] = [];

      // Simulate 10 agent loop iterations
      for (let i = 0; i < 10; i++) {
        messages.push({
          role: 'user',
          content: i === 0 ? 'Fix the failing tests' : `Continue fixing. Current state: ${i} issues resolved.`,
        });

        messages.push({
          role: 'assistant',
          content: [
            { type: 'text' as const, text: `Running iteration ${i}` },
            {
              type: 'tool_use' as const,
              id: `tool-${i}`,
              name: 'run_command',
              input: { command: 'npm test' },
            },
          ],
        });

        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: `tool-${i}`,
              content: `PASS: test ${i}\nFAIL: test ${i + 1}`.repeat(10), // Simulates output
            },
          ],
        });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 3,
        minCharsToSave: 500,
      });

      // Should have summarized older turns
      expect(result.metadata.turnsSummarized).toBeGreaterThan(0);
      // Freed chars should be significant
      expect(result.freedChars).toBeGreaterThan(100);
    });
  });
});
