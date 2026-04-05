import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, compressMessages } from './loop.js';
import type { ToolDefinition } from '../ollama/types.js';
import type { ChatMessage } from '../ollama/types.js';

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
  it('truncates long tool_result blocks outside the last 4 messages', () => {
    const longContent = 'x'.repeat(500);
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
    expect(compressed[0].content).toContain('... (truncated)');
    expect(compressed[0].content.length).toBeLessThan(longContent.length);
  });

  it('does not touch messages in the last 4', () => {
    const longContent = 'x'.repeat(500);
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: longContent }] },
      { role: 'assistant', content: 'msg2' },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'msg4' },
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
});
