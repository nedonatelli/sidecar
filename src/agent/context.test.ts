import { describe, it, expect } from 'vitest';
import { pruneHistory, enhanceContextWithSmartElements } from './context.js';
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

  it('returns the same reference when short-circuiting (caller must copy before mutating)', () => {
    // Regression: pruneHistory returns `messages` directly when length <= 2.
    // If the caller does `arr.length = 0; arr.push(...pruned)` without
    // copying first, both arrays are cleared because they are the same ref.
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const pruned = pruneHistory(msgs, 50_000);

    // Verify it IS the same reference (the short-circuit path)
    expect(pruned).toBe(msgs);

    // Simulate the safe pattern: copy before clearing
    const copy = [...pruned];
    msgs.length = 0;
    msgs.push(...copy);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('hello');
  });

  it('does not lose messages when pruned result equals input (2 messages)', () => {
    // Two messages: still under the short-circuit threshold (<=2)
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'What is your version?' },
      { role: 'assistant', content: [{ type: 'text', text: 'I am SideCar v0.28.1' }] },
    ];
    const pruned = pruneHistory(msgs, 100_000);
    expect(pruned).toHaveLength(2);
    expect(pruned[0].content).toBe('What is your version?');
  });

  it('compresses the latest turn when still over budget after dropping old turns', () => {
    // Build a single-turn conversation with a huge tool result
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read the big file' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading...' },
          { type: 'tool_use', id: 'tc_0', name: 'read_file', input: { path: 'big.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc_0', content: 'x'.repeat(10_000) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the file content: ' + 'y'.repeat(2000) }],
      },
    ];

    // Budget much smaller than the content — forces compression of the only turn
    const pruned = pruneHistory(msgs, 2_000);
    const totalChars = pruned.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + m.content.length;
      return (
        sum +
        m.content.reduce((s, b) => {
          if (b.type === 'text') return s + b.text.length;
          if (b.type === 'tool_result') return s + b.content.length;
          if (b.type === 'tool_use') return s + JSON.stringify(b.input).length;
          return s;
        }, 0)
      );
    }, 0);

    // Should be significantly smaller than original (~12K chars)
    expect(totalChars).toBeLessThan(5_000);
    // Should still have messages (not empty)
    expect(pruned.length).toBeGreaterThan(0);
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

describe('enhanceContextWithSmartElements', () => {
  it('returns context unchanged when no file sections found', () => {
    const result = enhanceContextWithSmartElements('plain text without sections', 'query');
    expect(result).toBe('plain text without sections');
  });

  it('returns context unchanged for empty input', () => {
    const result = enhanceContextWithSmartElements('', 'query');
    expect(result).toBe('');
  });

  it('preserves non-code file sections', () => {
    const context = '### README.md\nThis is documentation';
    const result = enhanceContextWithSmartElements(context, 'docs');
    expect(result).toContain('README.md');
    expect(result).toContain('documentation');
  });

  it('processes code file sections through AST analysis', () => {
    const context = '### src/app.ts\n```typescript\nexport function hello() { return "world"; }\n```';
    const result = enhanceContextWithSmartElements(context, 'hello function');
    // Should contain the file header and some content
    expect(result).toContain('app.ts');
  });

  it('handles multiple file sections', () => {
    const context = [
      '### src/a.ts\n```typescript\nconst x = 1;\n```',
      '### src/b.ts\n```typescript\nconst y = 2;\n```',
    ].join('\n');
    const result = enhanceContextWithSmartElements(context, 'variables');
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('handles AST parsing failures gracefully', () => {
    // Malformed code that might trip up the parser
    const context = '### src/broken.ts\n```typescript\n{{{invalid syntax\n```';
    const result = enhanceContextWithSmartElements(context, 'broken');
    // Should still return something (original content as fallback)
    expect(result).toContain('broken.ts');
  });
});
