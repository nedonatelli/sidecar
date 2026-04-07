import { describe, it, expect } from 'vitest';
import { pruneHistory } from './context.js';
import type { ChatMessage } from '../ollama/types.js';

/** Helper to create a realistic multi-turn conversation with tool calls. */
function buildConversation(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    // User prompt
    messages.push({ role: 'user', content: `Question ${t}: ${'context '.repeat(50)}` });
    // Assistant response with tool use
    messages.push({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thinking '.repeat(100) },
        { type: 'text', text: `Let me check that. ${'explanation '.repeat(30)}` },
        { type: 'tool_use', id: `tc_${t}`, name: 'read_file', input: { path: `src/file${t}.ts` } },
      ],
    });
    // Tool result (simulating a large file read)
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `tc_${t}`, content: 'x'.repeat(5000) }],
    });
    // Assistant final response
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `Here's what I found: ${'details '.repeat(100)}` }],
    });
  }
  return messages;
}

describe('pruneHistory', () => {
  it('returns messages unchanged when under 2 messages', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    expect(pruneHistory(msgs, 1000)).toEqual(msgs);
  });

  it('returns messages unchanged when maxChars is 0', () => {
    const msgs = buildConversation(3);
    expect(pruneHistory(msgs, 0)).toEqual(msgs);
  });

  it('preserves the last turn intact', () => {
    const msgs = buildConversation(3);
    const lastUserMsg = msgs[msgs.length - 4]; // last user prompt
    const pruned = pruneHistory(msgs, 50_000);
    // Last user message should be present and unchanged
    expect(pruned).toContainEqual(lastUserMsg);
  });

  it('compresses older tool results', () => {
    const msgs = buildConversation(5);
    const pruned = pruneHistory(msgs, 50_000);

    // Find the first tool result (from oldest turn)
    const firstToolResult = pruned.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    if (firstToolResult && Array.isArray(firstToolResult.content)) {
      const tr = firstToolResult.content.find((b) => b.type === 'tool_result');
      if (tr && tr.type === 'tool_result') {
        // Should be compressed from original 5000 chars
        expect(tr.content.length).toBeLessThan(5000);
      }
    }
  });

  it('strips thinking blocks from old turns', () => {
    const msgs = buildConversation(5);
    const pruned = pruneHistory(msgs, 50_000);

    // The oldest assistant message should have thinking removed (heavy compression)
    const oldAssistant = pruned[1]; // second message = first assistant response
    if (Array.isArray(oldAssistant?.content)) {
      const hasThinking = oldAssistant.content.some((b) => b.type === 'thinking');
      expect(hasThinking).toBe(false);
    }
  });

  it('drops oldest turns when over budget', () => {
    const msgs = buildConversation(10);
    // Set a very tight budget
    const pruned = pruneHistory(msgs, 5_000);
    expect(pruned.length).toBeLessThan(msgs.length);
    // The latest user message should still be present
    const lastUserContent = msgs[msgs.length - 4].content;
    const hasLast = pruned.some((m) => m.content === lastUserContent);
    expect(hasLast).toBe(true);
  });

  it('reduces total character count significantly for multi-turn conversations', () => {
    const msgs = buildConversation(6);
    const before = msgs.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + m.content.length;
      return (
        sum +
        m.content.reduce((s, b) => {
          if (b.type === 'text') return s + b.text.length;
          if (b.type === 'tool_result') return s + b.content.length;
          if (b.type === 'thinking') return s + b.thinking.length;
          if (b.type === 'tool_use') return s + JSON.stringify(b.input).length;
          return s;
        }, 0)
      );
    }, 0);

    const pruned = pruneHistory(msgs, 50_000);
    const after = pruned.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + m.content.length;
      return (
        sum +
        m.content.reduce((s, b) => {
          if (b.type === 'text') return s + b.text.length;
          if (b.type === 'tool_result') return s + b.content.length;
          if (b.type === 'thinking') return s + b.thinking.length;
          if (b.type === 'tool_use') return s + JSON.stringify(b.input).length;
          return s;
        }, 0)
      );
    }, 0);

    expect(after).toBeLessThan(before);
  });
});
