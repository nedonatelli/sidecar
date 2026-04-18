import { describe, it, expect, vi } from 'vitest';
import { parseTextToolCalls, compressMessages, stripRepeatedContent, runAgentLoop } from './loop.js';
import type { ToolDefinition, ChatMessage, StreamEvent } from '../ollama/types.js';
import type { SideCarClient } from '../ollama/client.js';
import type { AgentCallbacks } from './loop.js';

// Mock getToolDefinitions to avoid workspace API calls in tests
vi.mock('./tools.js', () => ({
  getToolDefinitions: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

const MOCK_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Write a file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'grep',
    description: 'Search',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'run_command',
    description: 'Run cmd',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

// ---------------------------------------------------------------------------
// parseTextToolCalls — unit tests
// ---------------------------------------------------------------------------
describe('parseTextToolCalls', () => {
  describe('Pattern 1: <function=name><parameter=key>value</parameter></function>', () => {
    it('parses a single function call', () => {
      const text = `Let me read that file.\n<function=read_file>\n<parameter=path>package.json</parameter>\n</function>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('read_file');
      expect(results[0].input).toEqual({ path: 'package.json' });
      expect(results[0].type).toBe('tool_use');
      expect(results[0].id).toMatch(/^text_tc_/);
    });

    it('parses multiple parameters', () => {
      const text = `<function=write_file>\n<parameter=path>src/index.ts</parameter>\n<parameter=content>console.log("hello")</parameter>\n</function>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].input).toEqual({ path: 'src/index.ts', content: 'console.log("hello")' });
    });

    it('parses multiple function calls in same text', () => {
      const text = `<function=read_file>\n<parameter=path>a.ts</parameter>\n</function>\nSome text\n<function=read_file>\n<parameter=path>b.ts</parameter>\n</function>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(2);
      expect(results[0].input.path).toBe('a.ts');
      expect(results[1].input.path).toBe('b.ts');
      expect(results[0].id).not.toBe(results[1].id);
    });

    it('ignores function calls with unknown tool names', () => {
      const text = `<function=unknown_tool>\n<parameter=foo>bar</parameter>\n</function>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(0);
    });

    it('trims parameter values', () => {
      const text = `<function=read_file>\n<parameter=path>  src/app.ts  </parameter>\n</function>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results[0].input.path).toBe('src/app.ts');
    });
  });

  describe('Pattern 2: <tool_call>JSON</tool_call>', () => {
    it('parses a tool_call block with name and arguments', () => {
      const text = `I'll search for that.\n<tool_call>\n{"name": "grep", "arguments": {"pattern": "TODO"}}\n</tool_call>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('grep');
      expect(results[0].input).toEqual({ pattern: 'TODO' });
    });

    it('parses nested function.name / function.arguments format', () => {
      const text = `<tool_call>\n{"function": {"name": "read_file", "arguments": {"path": "index.ts"}}}\n</tool_call>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('read_file');
      expect(results[0].input).toEqual({ path: 'index.ts' });
    });

    it('handles stringified arguments', () => {
      const text = `<tool_call>\n{"name": "grep", "arguments": "{\\"pattern\\": \\"fixme\\"}"}\n</tool_call>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].input).toEqual({ pattern: 'fixme' });
    });

    it('skips malformed JSON inside tool_call', () => {
      const text = `<tool_call>\nnot valid json\n</tool_call>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(0);
    });

    it('skips tool_call with unknown tool name', () => {
      const text = `<tool_call>\n{"name": "destroy_world", "arguments": {}}\n</tool_call>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(0);
    });
  });

  describe('Pattern 3: JSON in code fence', () => {
    it('parses a json code fence with name and arguments', () => {
      const text = 'Here\'s the call:\n```json\n{"name": "run_command", "arguments": {"command": "npm test"}}\n```';
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('run_command');
      expect(results[0].input).toEqual({ command: 'npm test' });
    });

    it('parses a bare code fence (no json label)', () => {
      const text = '```\n{"name": "read_file", "parameters": {"path": "README.md"}}\n```';
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(1);
      expect(results[0].input).toEqual({ path: 'README.md' });
    });

    it('ignores code fences with non-tool JSON', () => {
      const text = '```json\n{"version": "1.0", "description": "a config file"}\n```';
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(0);
    });
  });

  describe('priority ordering', () => {
    it('prefers Pattern 1 over Pattern 2 when both present', () => {
      const text = `<function=read_file>\n<parameter=path>a.ts</parameter>\n</function>\n<tool_call>\n{"name": "grep", "arguments": {"pattern": "x"}}\n</tool_call>`;
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      // Pattern 1 matches first and returns early
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('read_file');
    });
  });

  describe('edge cases', () => {
    it('returns empty array for plain text with no tool calls', () => {
      const text = 'This is just a normal response with no tool calls at all.';
      const results = parseTextToolCalls(text, MOCK_TOOLS);
      expect(results).toHaveLength(0);
    });

    it('returns empty array for empty string', () => {
      expect(parseTextToolCalls('', MOCK_TOOLS)).toHaveLength(0);
    });

    it('returns empty array when tools list is empty', () => {
      const text = `<function=read_file>\n<parameter=path>a.ts</parameter>\n</function>`;
      expect(parseTextToolCalls(text, [])).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// compressMessages — unit tests
// ---------------------------------------------------------------------------
describe('compressMessages', () => {
  it('truncates long tool_result blocks outside the last 2 messages', () => {
    const longContent = 'x'.repeat(1500);
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: longContent }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'msg4' },
      { role: 'user', content: 'msg5' },
      { role: 'assistant', content: 'msg6' },
    ];

    const freed = compressMessages(messages);
    expect(freed).toBeGreaterThan(0);

    const compressed = messages[0].content as Array<{ type: string; content: string }>;
    expect(compressed[0].content).toContain('...'); // The compression adds ellipsis
    expect(compressed[0].content.length).toBeLessThan(longContent.length);
  });

  it('does not touch messages in the last 2', () => {
    const longContent = 'x'.repeat(1500);
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: longContent }] },
      { role: 'assistant', content: 'msg2' },
    ];

    const freed = compressMessages(messages);
    expect(freed).toBe(0);
  });

  it('leaves short tool_result blocks unchanged', () => {
    const shortContent = 'short';
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: shortContent }] },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
      { role: 'assistant', content: 'e' },
    ];

    const freed = compressMessages(messages);
    expect(freed).toBe(0);
  });

  it('handles string content messages gracefully', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'just a string' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ];

    const freed = compressMessages(messages);
    expect(freed).toBe(0);
  });

  it('compresses more aggressively for older messages', () => {
    const longContent = 'x'.repeat(2000);
    const messages: ChatMessage[] = [];
    // Create 12 messages so the first one is far from the end
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tc${i}`, content: longContent }] });
      messages.push({ role: 'assistant', content: 'ok' });
    }

    compressMessages(messages);

    // First message (distFromEnd = 19) should be heavily compressed (maxLen=200)
    const first = messages[0].content as Array<{ type: string; content: string }>;
    expect(first[0].content.length).toBeLessThan(250);

    // Messages near the end (last 2) should be untouched
    const nearEnd = messages[messages.length - 2].content as Array<{ type: string; content: string }>;
    expect(nearEnd[0].content.length).toBe(2000);
  });

  it('drops thinking blocks from old messages (distFromEnd >= 8)', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'long reasoning '.repeat(20) },
          { type: 'text', text: 'answer' },
        ],
      });
      messages.push({ role: 'user', content: 'next' });
    }

    compressMessages(messages);

    // First assistant message (distFromEnd = 11) should have thinking dropped
    const first = messages[0].content as Array<{ type: string }>;
    const hasThinking = first.some((b) => b.type === 'thinking');
    expect(hasThinking).toBe(false);

    // Last assistant message (distFromEnd = 1) should keep thinking
    const last = messages[messages.length - 2].content as Array<{ type: string }>;
    const lastHasThinking = last.some((b) => b.type === 'thinking');
    expect(lastHasThinking).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripRepeatedContent — unit tests
// ---------------------------------------------------------------------------
describe('stripRepeatedContent', () => {
  it('strips text that appears in a previous assistant message', () => {
    const repeated = 'A'.repeat(250);
    const messages: ChatMessage[] = [{ role: 'assistant', content: `Here is the summary:\n\n${repeated}\n\nDone.` }];
    const text = `Let me continue.\n\n${repeated}\n\nNew content here.`;
    const result = stripRepeatedContent(text, messages);
    expect(result).not.toContain(repeated);
    expect(result).toContain('New content here');
  });

  it('does not strip short repeated content (under 200 chars)', () => {
    const short = 'A'.repeat(100);
    const messages: ChatMessage[] = [{ role: 'assistant', content: short }];
    const text = `Intro ${short} outro`;
    const result = stripRepeatedContent(text, messages);
    expect(result).toContain(short);
  });

  it('does not strip content inside code blocks', () => {
    const repeated = 'B'.repeat(250);
    const messages: ChatMessage[] = [{ role: 'assistant', content: repeated }];
    const text = '```\n' + repeated + '\n```';
    const result = stripRepeatedContent(text, messages);
    expect(result).toContain(repeated);
  });

  it('returns text unchanged when no previous messages', () => {
    const text = 'Hello world';
    const result = stripRepeatedContent(text, []);
    expect(result).toBe(text);
  });

  it('handles content block arrays in previous messages', () => {
    const repeated = 'C'.repeat(250);
    const messages: ChatMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: repeated }] }];
    const text = `Preamble.\n\n${repeated}\n\nAfterword.`;
    const result = stripRepeatedContent(text, messages);
    expect(result).not.toContain(repeated);
    expect(result).toContain('Preamble');
    expect(result).toContain('Afterword');
  });

  it('ignores user messages', () => {
    const repeated = 'D'.repeat(250);
    const messages: ChatMessage[] = [{ role: 'user', content: repeated }];
    const text = repeated;
    const result = stripRepeatedContent(text, messages);
    // User messages are skipped — content should remain
    expect(result).toContain(repeated);
  });
});

// ---------------------------------------------------------------------------
// runAgentLoop — timeout and error path tests
// ---------------------------------------------------------------------------
describe('runAgentLoop', () => {
  function makeCallbacks(): AgentCallbacks & { texts: string[] } {
    const texts: string[] = [];
    return {
      texts,
      onText: (t: string) => texts.push(t),
      onToolCall: () => {},
      onToolResult: () => {},
      onDone: () => {},
    };
  }

  function makeMockClient(generator: () => AsyncGenerator<StreamEvent>): SideCarClient {
    return {
      streamChat: generator,
      getSystemPrompt: () => '',
      // Phase 4b.2 wiring: loop.ts calls getRouter() before each turn.
      // Tests that don't exercise routing return null to take the
      // no-op branch.
      getRouter: () => null,
    } as unknown as SideCarClient;
  }

  it('times out when model never responds', async () => {
    // Generator that hangs forever
    async function* hanging(): AsyncGenerator<StreamEvent> {
      await new Promise(() => {}); // never resolves
      yield { type: 'text', text: 'unreachable' };
    }

    const cb = makeCallbacks();
    const ac = new AbortController();

    // Use a very short timeout (1 second)
    vi.spyOn(await import('../config/settings.js'), 'getConfig').mockReturnValue({
      requestTimeout: 1,
      agentMaxIterations: 25,
      agentMaxTokens: 100000,
      autoFixOnFailure: false,
      autoFixMaxRetries: 3,
    } as ReturnType<typeof import('../config/settings.js').getConfig>);

    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const result = await runAgentLoop(makeMockClient(hanging), messages, cb, ac.signal);

    expect(cb.texts.some((t) => t.includes('timed out'))).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(1);

    vi.restoreAllMocks();
  }, 10_000);

  it('completes normally when model responds within timeout', async () => {
    async function* responding(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', text: 'Hello!' };
      yield { type: 'stop', stopReason: 'end_turn' };
    }

    const cb = makeCallbacks();
    const ac = new AbortController();

    vi.spyOn(await import('../config/settings.js'), 'getConfig').mockReturnValue({
      requestTimeout: 30,
      agentMaxIterations: 25,
      agentMaxTokens: 100000,
      autoFixOnFailure: false,
      autoFixMaxRetries: 3,
    } as ReturnType<typeof import('../config/settings.js').getConfig>);

    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    await runAgentLoop(makeMockClient(responding), messages, cb, ac.signal);

    expect(cb.texts).toContain('Hello!');

    vi.restoreAllMocks();
  });

  it('stops when model produces no text or tools', async () => {
    // Model returns stop immediately with no text — loop should exit
    async function* emptyResponse(): AsyncGenerator<StreamEvent> {
      yield { type: 'stop', stopReason: 'end_turn' };
    }

    const cb = makeCallbacks();
    const ac = new AbortController();

    vi.spyOn(await import('../config/settings.js'), 'getConfig').mockReturnValue({
      requestTimeout: 30,
      agentMaxIterations: 25,
      agentMaxTokens: 100000,
      autoFixOnFailure: false,
      autoFixMaxRetries: 3,
    } as ReturnType<typeof import('../config/settings.js').getConfig>);

    const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    await runAgentLoop(makeMockClient(emptyResponse), messages, cb, ac.signal);

    // Should exit cleanly with no text
    expect(cb.texts).toHaveLength(0);

    vi.restoreAllMocks();
  });
});
