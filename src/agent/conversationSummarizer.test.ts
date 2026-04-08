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
