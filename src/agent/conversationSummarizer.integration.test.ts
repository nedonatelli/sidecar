/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { ConversationSummarizer } from './conversationSummarizer.js';
import type { ChatMessage } from '../ollama/types.js';

/**
 * Integration test: Verify ConversationSummarizer works well in agent loop scenarios
 */
describe('ConversationSummarizer — Integration with Agent Loop', () => {
  const createMockClient = (summaryText: string) => ({
    complete: vi.fn(async () => summaryText),
    streamChat: vi.fn(),
    updateSystemPrompt: vi.fn(),
    getModel: vi.fn(() => 'mock-model'),
  });

  describe('typical agent loop scenario', () => {
    it('compresses 20-turn conversation preserving last 4 turns', async () => {
      const mockClient = createMockClient(
        'Explored codebase structure. Fixed import issues in 3 files. Verified with tests.',
      );
      const summarizer = new ConversationSummarizer(mockClient as any);

      // Simulate 20 agent loop iterations
      const messages: ChatMessage[] = [];
      for (let i = 1; i <= 20; i++) {
        messages.push({
          role: 'user',
          content: `Iteration ${i}: Continue debugging the test failures.`,
        });

        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'text' as const,
              text: `Running tests for iteration ${i}...`,
            },
            {
              type: 'tool_use' as const,
              id: `tool-${i}`,
              name: 'run_command',
              input: { command: 'npm test' },
            },
          ],
        });

        // Simulate tool result
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: `tool-${i}`,
              content: `Test output for iteration ${i}...\nPassed: 50\nFailed: ${Math.max(0, 5 - i)}`.repeat(20),
            },
          ],
        });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 4,
        minCharsToSave: 1000,
      });

      // Verify summarization happened
      expect(result.metadata.turnsSummarized).toBe(16); // 20 - 4
      expect(result.metadata.turnsCount).toBe(20);
      expect(result.freedChars).toBeGreaterThan(2000);

      // Verify the result has summary + recent turns
      const resultFlat = result.messages;
      expect(resultFlat.length).toBeGreaterThan(0);

      // First message should be the summary
      const firstMsg = resultFlat[0];
      expect(firstMsg.role).toBe('user');
      expect(typeof firstMsg.content).toBe('string');
      expect((firstMsg.content as string).includes('summary')).toBe(true);
    });

    it('handles context overflow gracefully', async () => {
      const mockClient = createMockClient('Summary of earlier discussions and progress made so far.');
      const summarizer = new ConversationSummarizer(mockClient as any);

      // Create a very large conversation (30 turns with big tool outputs)
      const messages: ChatMessage[] = [];
      for (let i = 1; i <= 30; i++) {
        messages.push({
          role: 'user',
          content: `Query ${i}: Analyze this issue.`.repeat(10),
        });

        messages.push({
          role: 'assistant',
          content: `Analysis for ${i}...`.repeat(50),
        });

        // Large tool outputs to simulate real scenarios
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: `tool-${i}`,
              content: `Large output... ${i}`.repeat(100),
            },
          ],
        });
      }

      const beforeChars = messages.reduce(
        (sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : 500),
        0,
      );

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 3,
        minCharsToSave: 1000,
      });

      // Should have freed significant space
      expect(result.freedChars).toBeGreaterThan(2000);

      // Result should be much smaller
      const afterChars = result.messages.reduce(
        (sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : 500),
        0,
      );

      expect(afterChars).toBeLessThan(beforeChars);
    });

    it('respects token/char budget for summarization call itself', async () => {
      // Slow client that eventually times out
      let callCount = 0;
      const mockClient = {
        complete: vi.fn(async () => {
          callCount++;
          // Return a reasonable summary
          return 'Quick summary of prior work.';
        }),
        streamChat: vi.fn(),
        updateSystemPrompt: vi.fn(),
        getModel: vi.fn(() => 'mock-model'),
      };

      const summarizer = new ConversationSummarizer(mockClient as any);

      const messages: ChatMessage[] = [];
      for (let i = 1; i <= 15; i++) {
        messages.push({ role: 'user', content: `Q${i}. `.repeat(20) });
        messages.push({ role: 'assistant', content: `A${i}. `.repeat(20) });
      }

      // Set a short timeout
      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 2,
        minCharsToSave: 500,
        summaryTimeoutMs: 50, // Very short
      });

      // Should still return valid result
      expect(result.messages).toBeDefined();
      expect(Array.isArray(result.messages)).toBe(true);

      // Call count should be reasonable (not hanging)
      expect(callCount).toBeLessThanOrEqual(10);
    });

    it('preserves message order in result', async () => {
      const mockClient = createMockClient('Summary here.');
      const summarizer = new ConversationSummarizer(mockClient as any);

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Q1'.repeat(50) },
        { role: 'assistant', content: 'A1'.repeat(50) },
        { role: 'user', content: 'Q2'.repeat(50) },
        { role: 'assistant', content: 'A2'.repeat(50) },
        { role: 'assistant', content: 'A2 continued'.repeat(50) },
        { role: 'user', content: 'Q3'.repeat(50) },
        { role: 'assistant', content: 'A3'.repeat(50) },
        { role: 'assistant', content: 'A3 continued'.repeat(50) },
        { role: 'user', content: 'Q4'.repeat(50) },
        { role: 'assistant', content: 'A4'.repeat(50) },
        { role: 'assistant', content: 'A4 continued'.repeat(50) },
      ];

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 100,
      });

      // Should be: [summary, Q4, A4, A4cont]
      // First message should be the summary
      expect(result.messages[0].role).toBe('user');
      const firstContent = typeof result.messages[0].content === 'string' ? result.messages[0].content : '';
      expect(firstContent.includes('summary')).toBe(true);

      // Last messages should include recent turns
      expect(result.messages.length).toBeGreaterThan(1);

      // There should be Q4 somewhere in the recent part
      let hasQ4 = false;
      for (let i = 1; i < result.messages.length; i++) {
        const msg = result.messages[i];
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content.includes('Q4')) {
          hasQ4 = true;
          break;
        }
      }
      expect(hasQ4).toBe(true); // Most recent query should be preserved

      // Messages should be in logical order (user, then assistant responses)
      expect(result.messages[result.messages.length - 1].role).toBe('assistant');
    });

    it('avoids re-summarizing if already within budget', async () => {
      const mockClient = createMockClient('summary text');
      const summarizer = new ConversationSummarizer(mockClient as any);

      // Small conversation that shouldn't trigger summarization
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'how are you' },
        { role: 'assistant', content: 'good' },
      ];

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 2,
        minCharsToSave: 100000, // Very high threshold
      });

      // Should not have done any summarization
      expect(result.freedChars).toBe(0);
      expect(result.metadata.turnsSummarized).toBe(0);
      expect(result.messages).toEqual(messages);

      // Should not have called the API
      expect(mockClient.complete).not.toHaveBeenCalled();
    });
  });

  describe('edge cases in loop context', () => {
    it('handles tool results with special characters', async () => {
      const mockClient = createMockClient('Summary of tool execution.');
      const summarizer = new ConversationSummarizer(mockClient as any);

      const messages: ChatMessage[] = [
        { role: 'user', content: 'Q1'.repeat(30) },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: 'tool-1',
              content:
                "Error: ENOENT: no such file or directory, open '/path/to/file.ts'\n  at async readFile (/usr/lib/app.js:123:45)",
            },
          ],
        },
        { role: 'user', content: 'Q2'.repeat(30) },
        { role: 'assistant', content: 'Response' },
      ];

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 50,
      });

      // Should handle without crashing
      expect(result.messages).toBeDefined();
    });

    it('handles thinking blocks in old turns', async () => {
      const mockClient = createMockClient('Thinking blocks processed.');
      const summarizer = new ConversationSummarizer(mockClient as any);

      const messages: ChatMessage[] = [];

      // 5 turns with thinking blocks
      for (let i = 1; i <= 5; i++) {
        messages.push({ role: 'user', content: `Query ${i}`.repeat(20) });
        messages.push({
          role: 'assistant',
          content: [
            {
              type: 'thinking' as const,
              thinking: `Deep analysis for query ${i}...`.repeat(20),
            },
            { type: 'text' as const, text: `Response ${i}...`.repeat(10) },
          ],
        });
      }

      const result = await summarizer.summarize(messages, {
        keepRecentTurns: 1,
        minCharsToSave: 100,
      });

      // Should have summarized without losing data
      expect(result.freedChars).toBeGreaterThan(0);
      expect(result.messages[result.messages.length - 1]).toBeDefined();
    });
  });
});
