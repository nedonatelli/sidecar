import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, stripRepeatedContent } from './textParsing.js';
import type { ToolDefinition, ChatMessage } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for textParsing.ts (v0.65 chunk 2a — loop helper hardening).
//
// Two pure helpers: `parseTextToolCalls` (tool-call-in-prose fallback for
// models that don't emit structured tool_use blocks) and
// `stripRepeatedContent` (dedup stale paragraphs echoed from history).
// No external deps, no vscode dependency — tests are fast and synchronous.
// ---------------------------------------------------------------------------

function defineTools(...names: string[]): ToolDefinition[] {
  return names.map((name) => ({
    name,
    description: `${name} tool`,
    input_schema: { type: 'object', properties: {} },
  }));
}

describe('parseTextToolCalls', () => {
  const tools = defineTools('read_file', 'run_command', 'grep');

  describe('no match', () => {
    it('returns [] for plain prose with no tool-call markers', () => {
      expect(parseTextToolCalls('Here is a plan I thought about.', tools)).toEqual([]);
    });

    it('returns [] when the matched tool name is unknown', () => {
      expect(parseTextToolCalls('<function=bogus_tool><parameter=x>y</parameter></function>', tools)).toEqual([]);
    });

    it('returns [] when the JSON body is malformed', () => {
      expect(parseTextToolCalls('<tool_call>{bad json}</tool_call>', tools)).toEqual([]);
    });
  });

  describe('<function=...> pattern', () => {
    it('parses a single function-tag call with parameters', () => {
      const input = '<function=read_file><parameter=path>src/foo.ts</parameter></function>';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        name: 'read_file',
        input: { path: 'src/foo.ts' },
      });
    });

    it('parses multiple parameters in one function tag', () => {
      const input = `<function=run_command><parameter=cmd>npm test</parameter><parameter=cwd>/proj</parameter></function>`;
      const result = parseTextToolCalls(input, tools);
      expect(result[0].input).toEqual({ cmd: 'npm test', cwd: '/proj' });
    });

    it('parses multiple function tags in a single text', () => {
      const input =
        '<function=read_file><parameter=path>a.ts</parameter></function>' +
        '<function=read_file><parameter=path>b.ts</parameter></function>';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(2);
      expect(result[0].input).toEqual({ path: 'a.ts' });
      expect(result[1].input).toEqual({ path: 'b.ts' });
    });

    it('skips function tags whose tool name is not in the registered tools', () => {
      const input =
        '<function=unknown_tool><parameter=x>1</parameter></function>' +
        '<function=read_file><parameter=path>a.ts</parameter></function>';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
    });
  });

  describe('<tool_call>JSON</tool_call> pattern', () => {
    it('parses a direct {name, arguments} call', () => {
      const input = `<tool_call>{"name": "grep", "arguments": {"pattern": "foo"}}</tool_call>`;
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'grep', input: { pattern: 'foo' } });
    });

    it('parses nested {function: {name, arguments}} OpenAI-style shape', () => {
      const input = `<tool_call>{"function": {"name": "read_file", "arguments": {"path": "x.ts"}}}</tool_call>`;
      const result = parseTextToolCalls(input, tools);
      expect(result[0].input).toEqual({ path: 'x.ts' });
    });

    it('parses stringified-JSON `arguments` (some providers double-encode)', () => {
      const input = `<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"x.ts\\"}"}</tool_call>`;
      const result = parseTextToolCalls(input, tools);
      expect(result[0].input).toEqual({ path: 'x.ts' });
    });

    it('skips a malformed JSON body without throwing', () => {
      const input = `<tool_call>{broken}</tool_call>`;
      expect(() => parseTextToolCalls(input, tools)).not.toThrow();
      expect(parseTextToolCalls(input, tools)).toEqual([]);
    });
  });

  describe('```json fenced block pattern', () => {
    it('parses a fenced JSON block with {name, arguments}', () => {
      const input = '```json\n{"name": "grep", "arguments": {"pattern": "foo"}}\n```';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('grep');
    });

    it('parses a fenced block with `tool` + `input` keys (Qwen-style)', () => {
      const input = '```json\n{"tool": "read_file", "input": {"path": "x.ts"}}\n```';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'read_file', input: { path: 'x.ts' } });
    });

    it('parses a bare ``` fenced block (no json language tag)', () => {
      const input = '```\n{"name": "grep", "parameters": {"pattern": "x"}}\n```';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].input).toEqual({ pattern: 'x' });
    });
  });

  describe('pattern-type priority (first-match wins)', () => {
    it('ignores later <tool_call> patterns when a <function> came first', () => {
      const input =
        '<function=read_file><parameter=path>a.ts</parameter></function>' +
        '<tool_call>{"name": "grep", "arguments": {"pattern": "x"}}</tool_call>';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
    });

    it('ignores later fenced JSON when a <tool_call> came first', () => {
      const input =
        '<tool_call>{"name": "grep", "arguments": {"pattern": "x"}}</tool_call>' +
        '```json\n{"name": "read_file", "arguments": {"path": "a"}}\n```';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('grep');
    });
  });

  describe('bare JSON line pattern (Ollama style)', () => {
    it('parses a bare JSON line with {name, parameters}', () => {
      const input =
        'Let me check the current value of n_ctx.\n' +
        '{"name": "read_file", "parameters": {"path": "src/config/settings.ts"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
      expect(result[0].input).toEqual({ path: 'src/config/settings.ts' });
    });

    it('parses a bare JSON line with {name, arguments}', () => {
      const input = '{"name": "grep", "arguments": {"pattern": "n_ctx", "path": "src"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('grep');
    });

    it('ignores bare JSON whose name is not a known tool', () => {
      const input = '{"name": "not_a_tool", "parameters": {"x": 1}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(0);
    });

    it('ignores bare JSON when a <tool_call> pattern appeared first', () => {
      const input =
        '<tool_call>{"name": "grep", "arguments": {"pattern": "x"}}</tool_call>\n' +
        '{"name": "read_file", "parameters": {"path": "a"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('grep');
    });

    it('parses multiple bare JSON lines in the same turn', () => {
      const input =
        'First call:\n{"name": "read_file", "parameters": {"path": "a.ts"}}\n' +
        'Second call:\n{"name": "grep", "parameters": {"pattern": "foo", "path": "src"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('read_file');
      expect(result[1].name).toBe('grep');
    });
  });
});

describe('stripRepeatedContent', () => {
  const longParagraph = 'A'.repeat(250); // >= 200 chars triggers dedup
  const otherLong = 'B'.repeat(250);

  it('returns the text unchanged when the history has no prior assistant messages', () => {
    expect(stripRepeatedContent(`${longParagraph}\n\nnew content`, [])).toBe(`${longParagraph}\n\nnew content`);
  });

  it('returns the text unchanged when no paragraph ≥ 200 chars appears in history', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: 'short reply' }];
    expect(stripRepeatedContent(`${longParagraph}\n\nnew`, history)).toBe(`${longParagraph}\n\nnew`);
  });

  it('removes a long paragraph that was in an earlier assistant turn', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: longParagraph }];
    const incoming = `${longParagraph}\n\nfresh text here.`;
    const result = stripRepeatedContent(incoming, history);
    expect(result).not.toContain(longParagraph);
    expect(result).toContain('fresh text here.');
  });

  it('preserves content inside ``` code blocks even when it matches history', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: longParagraph }];
    const incoming = `Leading prose.\n\n\`\`\`\n${longParagraph}\n\`\`\``;
    const result = stripRepeatedContent(incoming, history);
    expect(result).toContain(longParagraph); // inside the code fence — not stripped
    expect(result).toContain('```');
  });

  it('does not dedup short paragraphs even if they match history exactly', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: 'short' }];
    const incoming = `short\n\nshort`;
    expect(stripRepeatedContent(incoming, history)).toBe(`short\n\nshort`);
  });

  it('reads assistant messages whose content is an array of content blocks', () => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: longParagraph }],
      },
    ];
    const result = stripRepeatedContent(`${longParagraph}\n\nnew`, history);
    expect(result).not.toContain(longParagraph);
    expect(result).toContain('new');
  });

  it('only looks at assistant messages (user history is not dedup source)', () => {
    const history: ChatMessage[] = [{ role: 'user', content: longParagraph }];
    expect(stripRepeatedContent(`${longParagraph}\n\nnew`, history)).toContain(longParagraph);
  });

  it('collapses ≥3 consecutive newlines left behind by deletion', () => {
    const history: ChatMessage[] = [{ role: 'assistant', content: longParagraph }];
    const incoming = `before\n\n${longParagraph}\n\n${otherLong}\n\nafter`;
    const result = stripRepeatedContent(incoming, history);
    expect(result).not.toContain(longParagraph);
    // No stretch of 3+ newlines should remain.
    expect(result).not.toMatch(/\n{3,}/);
  });
});
