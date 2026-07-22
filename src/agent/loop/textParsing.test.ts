import { describe, it, expect } from 'vitest';
import {
  parseTextToolCalls,
  parseTextToolCallsCleaned,
  stripRepeatedContent,
  parseMangledToolName,
  splitTopLevelArgs,
  coerceArgValue,
  synthesizeFenceWrite,
} from './textParsing.js';
import type { ToolDefinition, ChatMessage } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for textParsing.ts (loop helper hardening).
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

    it('returns [] when the JSON body is malformed with no salvageable name', () => {
      expect(parseTextToolCalls('<tool_call>{bad json}</tool_call>', tools)).toEqual([]);
    });
  });

  describe('malformed-but-salvageable (A5 — no silent drop)', () => {
    it('emits a _malformedInputRaw marker for a tool_call with a known name', () => {
      // Valid name, broken args (trailing comma + unquoted) — would have been dropped.
      const raw = '{"name":"read_file","arguments":{path: "a.ts",}}';
      const result = parseTextToolCalls(`<tool_call>${raw}</tool_call>`, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'read_file', input: {}, _malformedInputRaw: raw });
    });

    it('emits a marker for a malformed bare-JSON tool call', () => {
      const raw = '{"name":"grep", "arguments":{"pattern": unquoted}}';
      const result = parseTextToolCalls(raw, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'grep', _malformedInputRaw: expect.stringContaining('grep') });
    });

    it('still drops a malformed call whose name is not a known tool', () => {
      expect(parseTextToolCalls('<tool_call>{"name":"bogus","arguments":{x:}}</tool_call>', tools)).toEqual([]);
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

    it('parses a fenced block with `tool` + `args` keys (Devstral-style) — args must not be dropped', () => {
      // Exact shape captured from devstral:24b in the agent loop. Before the fix
      // the `args` key was not in the extraction chain, so `path` silently
      // dropped to {} and the tool failed with "missing required parameter".
      const input = '```json\n{\n  "tool": "read_file",\n  "args": {\n    "path": "src/fact.ts"\n  }\n}\n```';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'read_file', input: { path: 'src/fact.ts' } });
    });

    it('accepts the `args` key in a <tool_call> block too', () => {
      const input = '<tool_call>{"name": "grep", "args": {"pattern": "foo"}}</tool_call>';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'grep', input: { pattern: 'foo' } });
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

    it('parses the OpenAI function-call shape with nested name/parameters (llama3.2 live)', () => {
      const input =
        'I will read the config file.\n' +
        '{"type":"function","function":{"name":"read_file","parameters":{"path":"config/app.json"}}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
      expect(result[0].input).toEqual({ path: 'config/app.json' });
    });

    it('parses the OpenAI function-call shape with nested arguments', () => {
      const input = '{"type":"function","function":{"name":"grep","arguments":{"pattern":"port","path":"config"}}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('grep');
      expect(result[0].input).toEqual({ pattern: 'port', path: 'config' });
    });

    it('salvages a truncated bare JSON call missing its closing brace (llama3.2 live)', () => {
      // Observed live in the latch-stale-fact eval: the emission ended one
      // brace short, so the depth scan never closed and the call was
      // silently dropped — the model looked like it "chose" not to read.
      const input = '{"type":"function","function":{"name":"read_file","parameters":{"path":"config.json"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('read_file');
      expect(result[0]._malformedInputRaw).toBeDefined();
    });

    it('does not salvage truncated JSON without a known tool name', () => {
      const input = '{"type":"function","function":{"name":"not_a_tool","parameters":{"x":1}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(0);
    });

    it('parses a call glued to the previous closing fence (qwen2.5-coder live)', () => {
      // The seed used to require a line-anchored `{`, so a call emitted
      // immediately after a closing ``` fence was never found: salvageToolName
      // recovered the NAME and the repair layer produced edit_file({}) — empty
      // arguments. The model's edit was correct and complete; SideCar threw the
      // arguments away, bounced it on schema validation, and the model gave up
      // on a task it had actually solved.
      const input =
        '```json\n{"name": "grep", "arguments": {"pattern": "greet"}}\n```' +
        '{"name": "read_file", "arguments": {"path": "src/greeter.ts"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1); // first-pattern-wins: the fenced call
      expect(result[0].name).toBe('grep');

      // On a turn with no fence, the glued/mid-line object must parse fully.
      const glued = 'Here you go: {"name": "read_file", "arguments": {"path": "src/greeter.ts"}}';
      const r2 = parseTextToolCalls(glued, tools);
      expect(r2).toHaveLength(1);
      expect(r2[0].name).toBe('read_file');
      expect(r2[0].input).toEqual({ path: 'src/greeter.ts' });
    });

    it('parses a call whose argument VALUES contain braces (qwen2.5-coder live)', () => {
      // The commonest call of all — a code edit — carries braces inside its
      // string values. A naive brace-depth scan ran off on `… : string {`,
      // decided the object was truncated, threw the arguments away, and
      // dispatched edit_file({}). The model then apologized and gave up on a
      // rename it had gotten right on the first attempt.
      const editTools = defineTools('edit_file');
      const input =
        '{"name": "edit_file", "arguments": {"path":"src/greeter.ts",' +
        '"search":"export function greet(name: string): string {",' +
        '"replace":"export function welcome(name: string): string {"}}';
      const result = parseTextToolCalls(input, editTools);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('edit_file');
      expect(result[0].input).toEqual({
        path: 'src/greeter.ts',
        search: 'export function greet(name: string): string {',
        replace: 'export function welcome(name: string): string {',
      });
      expect(result[0]._malformedInputRaw).toBeUndefined(); // NOT a repair path
    });

    it('handles escaped quotes and newlines inside argument values', () => {
      const editTools = defineTools('edit_file');
      const input =
        '{"name": "edit_file", "arguments": {"path":"a.ts",' +
        '"search":"say(\\"hi\\") {",' +
        '"replace":"say(\\"bye\\") {\\n  return 1;\\n}"}}';
      const result = parseTextToolCalls(input, editTools);
      expect(result).toHaveLength(1);
      expect(result[0].input).toMatchObject({ path: 'a.ts' });
      expect(result[0]._malformedInputRaw).toBeUndefined();
    });

    it('does not double-parse an argument object as a second call', () => {
      const input = '{"name": "run_command", "arguments": {"command": "npm test", "cwd": "/proj"}}';
      const result = parseTextToolCalls(input, tools);
      expect(result).toHaveLength(1);
      expect(result[0].input).toEqual({ command: 'npm test', cwd: '/proj' });
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

describe('parseMangledToolName', () => {
  it('recovers the base name + kwargs from a call-expression name (the qwen3.5 case)', () => {
    // The exact shape seen in the agent trajectory: name captured the whole call.
    expect(parseMangledToolName('read_file(path="src/greeter.ts")')).toEqual({
      name: 'read_file',
      input: { path: 'src/greeter.ts' },
    });
  });

  it('parses multiple kwargs with mixed value types', () => {
    expect(parseMangledToolName('read_file(path="src/utils.ts", start_line=5, end_line=10)')).toEqual({
      name: 'read_file',
      input: { path: 'src/utils.ts', start_line: 5, end_line: 10 },
    });
  });

  it('handles single-quoted strings, booleans, and Python None', () => {
    expect(parseMangledToolName("grep(pattern='foo', recursive=True, limit=None)")).toEqual({
      name: 'grep',
      input: { pattern: 'foo', recursive: true, limit: null },
    });
  });

  it('parses an embedded JSON object form', () => {
    expect(parseMangledToolName('read_file({"path":"src/x.ts","start_line":3})')).toEqual({
      name: 'read_file',
      input: { path: 'src/x.ts', start_line: 3 },
    });
  });

  it('does not split on commas inside quoted values', () => {
    expect(parseMangledToolName('run_command(cmd="echo a, b, c")')).toEqual({
      name: 'run_command',
      input: { cmd: 'echo a, b, c' },
    });
  });

  it('returns the base name with empty input for an empty arg list', () => {
    expect(parseMangledToolName('list_directory()')).toEqual({ name: 'list_directory', input: {} });
  });

  it('returns empty input for positional-only args (unmappable without schema)', () => {
    // No `key=` — nothing to map, but the base name still resolves downstream.
    expect(parseMangledToolName('read_file("src/x.ts")')).toEqual({ name: 'read_file', input: {} });
  });

  it('returns null for a legitimate plain tool name (never fires on valid calls)', () => {
    expect(parseMangledToolName('read_file')).toBeNull();
    expect(parseMangledToolName('get_diagnostics')).toBeNull();
    expect(parseMangledToolName('mcp_server_do_thing')).toBeNull();
  });

  it('returns null for non-call garbage', () => {
    expect(parseMangledToolName('')).toBeNull();
    expect(parseMangledToolName('read file please')).toBeNull();
    expect(parseMangledToolName('{"name":"read_file"}')).toBeNull();
  });
});

describe('coerceArgValue', () => {
  it('strips double- and single-quoted strings', () => {
    expect(coerceArgValue('"hello"')).toBe('hello');
    expect(coerceArgValue("'hello'")).toBe('hello');
  });

  it('coerces booleans (both cases)', () => {
    expect(coerceArgValue('true')).toBe(true);
    expect(coerceArgValue('True')).toBe(true);
    expect(coerceArgValue('false')).toBe(false);
    expect(coerceArgValue('False')).toBe(false);
  });

  it('coerces null and Python None', () => {
    expect(coerceArgValue('null')).toBeNull();
    expect(coerceArgValue('None')).toBeNull();
  });

  it('coerces integers (incl. negative) and floats', () => {
    expect(coerceArgValue('42')).toBe(42);
    expect(coerceArgValue('-5')).toBe(-5);
    expect(coerceArgValue('3.14')).toBe(3.14);
    expect(coerceArgValue('-0.5')).toBe(-0.5);
  });

  it('leaves barewords as strings and trims whitespace', () => {
    expect(coerceArgValue('hello')).toBe('hello');
    expect(coerceArgValue('  spaced  ')).toBe('spaced');
    // Not a full number → stays a string.
    expect(coerceArgValue('12abc')).toBe('12abc');
  });

  it('does not coerce a value that only partially looks quoted', () => {
    // Leading quote but no trailing quote → treated as a bareword, not stripped.
    expect(coerceArgValue('"unterminated')).toBe('"unterminated');
  });
});

describe('splitTopLevelArgs', () => {
  it('splits simple comma-separated parts', () => {
    expect(splitTopLevelArgs('a=1, b=2, c=3')).toEqual(['a=1', ' b=2', ' c=3']);
  });

  it('does not split on commas inside double- or single-quoted strings', () => {
    expect(splitTopLevelArgs('a="x, y", b=2')).toEqual(['a="x, y"', ' b=2']);
    expect(splitTopLevelArgs("a='x, y', b=2")).toEqual(["a='x, y'", ' b=2']);
  });

  it('does not split on commas inside (), [], or {}', () => {
    expect(splitTopLevelArgs('a=[1, 2], b={3, 4}, c=f(5, 6)')).toEqual(['a=[1, 2]', ' b={3, 4}', ' c=f(5, 6)']);
  });

  it('treats an escaped quote as literal — does not end the quoted region early', () => {
    // The \" must NOT close the string, so the comma stays inside one part.
    expect(splitTopLevelArgs('a="x \\" , y", b=2')).toEqual(['a="x \\" , y"', ' b=2']);
  });

  it('keeps a single arg with no top-level comma as one part', () => {
    expect(splitTopLevelArgs('path="src/x.ts"')).toEqual(['path="src/x.ts"']);
  });

  it('drops a trailing empty/whitespace-only segment after a trailing comma', () => {
    expect(splitTopLevelArgs('a=1, ')).toEqual(['a=1']);
  });
});

describe('parseTextToolCalls — argument-key and name-key variants', () => {
  const tools = defineTools('read_file', 'grep');

  // Each variant present in isolation, so dropping ANY key from the fallback
  // chain (arguments / args / parameters / input / function.arguments) breaks it.
  it('reads args from `arguments`', () => {
    expect(
      parseTextToolCalls('<tool_call>{"name":"grep","arguments":{"pattern":"a"}}</tool_call>', tools)[0].input,
    ).toEqual({ pattern: 'a' });
  });
  it('reads args from `args`', () => {
    expect(parseTextToolCalls('<tool_call>{"name":"grep","args":{"pattern":"b"}}</tool_call>', tools)[0].input).toEqual(
      {
        pattern: 'b',
      },
    );
  });
  it('reads args from `parameters`', () => {
    expect(
      parseTextToolCalls('<tool_call>{"name":"grep","parameters":{"pattern":"c"}}</tool_call>', tools)[0].input,
    ).toEqual({ pattern: 'c' });
  });
  it('reads args from nested `function.arguments` in a <tool_call>', () => {
    expect(
      parseTextToolCalls('<tool_call>{"function":{"name":"grep","arguments":{"pattern":"d"}}}</tool_call>', tools)[0]
        .input,
    ).toEqual({ pattern: 'd' });
  });
  it('reads args from `input` in a fenced block', () => {
    expect(parseTextToolCalls('```json\n{"tool":"grep","input":{"pattern":"e"}}\n```', tools)[0].input).toEqual({
      pattern: 'e',
    });
  });

  // Name-key variants: name / tool / function.name.
  it('reads the name from `tool`', () => {
    expect(parseTextToolCalls('<tool_call>{"tool":"read_file","args":{"path":"x"}}</tool_call>', tools)[0].name).toBe(
      'read_file',
    );
  });
  it('reads the name from nested `function.name`', () => {
    expect(
      parseTextToolCalls('<tool_call>{"function":{"name":"read_file","arguments":{"path":"y"}}}</tool_call>', tools)[0]
        .name,
    ).toBe('read_file');
  });
});

// ---------------------------------------------------------------------------
// parseTextToolCallsCleaned — the excision path.
//
// This is what removes a dispatched text-form tool call from the assistant's
// VISIBLE text, so the user doesn't read raw JSON in the chat. It had no direct
// tests: Stryker left every span mutant alive, including
// `[match.index, match.index + match[0].length]` → `- match[0].length` (a NEGATIVE
// span end) and `spans.sort((a,b) => a[0] - b[0])` → `a[0] + b[0]`. Some were not
// even covered.
//
// Also unpinned: `idCounter++` → `idCounter--`. Tool-use ids must be unique within
// a turn — colliding ids break tool_result matching, and nothing asserted it.
// ---------------------------------------------------------------------------

describe('parseTextToolCallsCleaned — excises the dispatched call from the text', () => {
  const tools = defineTools('read_file', 'grep');

  it('removes the tool-call JSON and keeps the surrounding prose', () => {
    const text =
      'Let me look.\n```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```\nThen I will report.';
    const { calls, cleanedText } = parseTextToolCallsCleaned(text, tools);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    // The JSON must be gone — this is the whole point.
    expect(cleanedText).not.toContain('read_file');
    expect(cleanedText).not.toContain('{');
    expect(cleanedText).toContain('Let me look.');
    expect(cleanedText).toContain('Then I will report.');
  });

  it('gives every call in a turn a UNIQUE id', () => {
    // `idCounter--` produces colliding / negative ids, which silently breaks the
    // tool_use → tool_result pairing.
    const text =
      '```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```\n' +
      '```json\n{"name": "grep", "arguments": {"pattern": "TODO"}}\n```';
    const { calls } = parseTextToolCallsCleaned(text, tools);

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  });

  it('excises MULTIPLE calls without eating the prose between them', () => {
    // A negative or mis-sorted span silently swallows the text around it.
    const text =
      'First:\n```json\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n```\n' +
      'Middle prose.\n```json\n{"name": "grep", "arguments": {"pattern": "TODO"}}\n```\nTail prose.';
    const { calls, cleanedText } = parseTextToolCallsCleaned(text, tools);

    expect(calls).toHaveLength(2);
    expect(cleanedText).toContain('First:');
    expect(cleanedText).toContain('Middle prose.');
    expect(cleanedText).toContain('Tail prose.');
    expect(cleanedText).not.toContain('"name"');
  });

  it('leaves text untouched when there is no tool call in it', () => {
    const text = 'Just an explanation, no calls here.';
    expect(parseTextToolCallsCleaned(text, tools)).toEqual({ calls: [], cleanedText: text });
  });

  it('does not accept a name that is not a real tool', () => {
    // `canonical !== null && toolNames.has(canonical)` → `||` accepts ANY non-null
    // name, dispatching a tool that does not exist.
    const text = '```json\n{"name": "definitely_not_a_tool", "arguments": {"x": 1}}\n```';
    const { calls } = parseTextToolCallsCleaned(text, tools);
    expect(calls).toHaveLength(0);
  });
  // Each emission syntax is a SEPARATE branch with its own span push. The fenced
  // ```json tests above cover only one of them; Stryker showed the others' spans
  // untested (some entirely uncovered), so a broken excision there would leak raw
  // tool-call syntax into the chat with no test failing.

  it('excises a <tool_call> emission', () => {
    const text = 'Checking.\n<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>\nDone.';
    const { calls, cleanedText } = parseTextToolCallsCleaned(text, tools);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(cleanedText).not.toContain('tool_call');
    expect(cleanedText).not.toContain('read_file');
    expect(cleanedText).toContain('Checking.');
    expect(cleanedText).toContain('Done.');
  });

  it('excises a <function=...> emission', () => {
    const text = 'Now.\n<function=read_file>\n<parameter=path>\na.ts\n</parameter>\n</function>\nThat is it.';
    const { calls, cleanedText } = parseTextToolCallsCleaned(text, tools);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].input).toEqual({ path: 'a.ts' });
    expect(cleanedText).not.toContain('<function');
    expect(cleanedText).not.toContain('<parameter');
    expect(cleanedText).toContain('Now.');
    expect(cleanedText).toContain('That is it.');
  });
});

describe('parseCallExpressions (pattern 5 — code-as-text recovery, opt-in)', () => {
  const tools = defineTools('read_file', 'write_file', 'edit_file', 'run_tests');
  const opts = { callExpressions: true };

  it('parses the live qwen2.5-coder shape: a complete write_file call in backticks', () => {
    // Verbatim shape from the lh-calculator-session trajectory (2026-07-17):
    // told "emit the tool call", the model printed the complete correct call as prose.
    const text =
      "Let's proceed with these steps directly:\n" +
      '1. `write_file(path="calculator.py", content="def add(a, b):\\n  return a + b\\n\\ndef divide(a, b):\\n  if b == 0:\\n  raise ValueError(\\"Cannot divide by zero\\")\\n  return a / b")`\n';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(calls[0].input.path).toBe('calculator.py');
    // Escapes decode to REAL newlines and quotes — the file must not land as one line of \n literals.
    expect(calls[0].input.content).toContain('def add(a, b):\n  return a + b');
    expect(calls[0].input.content).toContain('raise ValueError("Cannot divide by zero")');
  });

  it('parses multiple calls as a plan, in order', () => {
    const text =
      '1. `edit_file(path="calculator.py", search="def add", replace="def add2")`\n' +
      '2. `run_tests(file="test_calculator.py")`';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls.map((c) => c.name)).toEqual(['edit_file', 'run_tests']);
    expect(calls[1].input).toEqual({ file: 'test_calculator.py' });
  });

  it('collapses the narrated call and the "let us proceed" duplicate into one', () => {
    const text =
      'I will run `run_tests(file="test_calculator.py")`.\n\nProceeding:\nrun_tests(file="test_calculator.py")';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
  });

  it('is OFF by default — the same text parses to nothing without the opt', () => {
    const text = '`write_file(path="a.py", content="x = 1")`';
    expect(parseTextToolCalls(text, tools)).toEqual([]);
  });

  it('never fires when another pattern already matched (rescue-only priority)', () => {
    const text =
      '```json\n{"name": "read_file", "arguments": {"path": "a.py"}}\n```\n' +
      'Then `write_file(path="a.py", content="x")`.';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('ignores calls inside source-language fences — that is code, not a tool call', () => {
    const text = '```python\nresult = read_file(path="data.csv")\n```';
    expect(parseTextToolCalls(text, tools, opts)).toEqual([]);
  });

  it('still parses calls inside sh and unlabelled fences', () => {
    const text = '```sh\nrun_tests(file="test_calculator.py")\n```';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('run_tests');
  });

  it('rejects attribute access, positional args, unknown names, and empty calls', () => {
    const tests = [
      'calculator.read_file(path="x.py") is how the module loads it', // attribute access
      'call read_file("x.py") to load it', // positional
      'not_a_tool(path="x.py")', // unknown name
      'read_file() returns the contents', // no args
    ];
    for (const text of tests) {
      expect(parseTextToolCalls(text, tools, opts)).toEqual([]);
    }
  });

  it('handles parens and escaped quotes inside string arguments', () => {
    const text = 'write_file(path="a.py", content="print(\\"hi (there)\\")\\n")';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.content).toBe('print("hi (there)")\n');
  });

  it('excises the call (and wrapping backticks) from the cleaned text', () => {
    const text = 'Applying now:\n`write_file(path="a.py", content="x = 1")`\nDone.';
    const { calls, cleanedText } = parseTextToolCallsCleaned(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(cleanedText).not.toContain('write_file');
    expect(cleanedText).not.toContain('`');
    expect(cleanedText).toContain('Applying now:');
    expect(cleanedText).toContain('Done.');
  });

  it('caps runaway matches at 5 calls', () => {
    const text = Array.from({ length: 9 }, (_, i) => `read_file(path="f${i}.py")`).join('\n');
    expect(parseTextToolCalls(text, tools, opts)).toHaveLength(5);
  });

  it('resolves aliased names so create_file still dispatches', () => {
    const text = 'create_file(path="new.py", content="x = 1")';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('create_file'); // alias preserved; executor discloses the canonical name
  });
});

describe('parseCallExpressions — placeholder echo rejection', () => {
  const tools = defineTools('write_file', 'read_file');
  const opts = { callExpressions: true };

  it('rejects a call whose arg is an angle-bracket template slot (live reprompt echo)', () => {
    const text =
      'write_file(path="calculator.py", content="<the COMPLETE file — everything already in it PLUS your new code>")';
    expect(parseTextToolCalls(text, tools, opts)).toEqual([]);
  });

  it('still accepts real content that merely contains angle brackets', () => {
    const text = 'write_file(path="index.html", content="<html>\\n<body>hi</body>\\n</html>")';
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].input.content).toContain('<body>hi</body>');
  });
});

describe('triple-quoted strings + fence-carrier calls (campaign corpus shapes)', () => {
  const tools = defineTools('write_file', 'read_file');
  const opts = { callExpressions: true };

  it('parses the r20 shape: write_file with triple-quoted content inside a python fence', () => {
    const text =
      "Now, let's write this to the file:\n```python\nwrite_file(path=\"calculator.py\", content='''def add(a, b):\n  return a + b\n\ndef divide(a, b):\n  if b == 0:\n    raise ValueError(\"Cannot divide by zero\")\n  return a / b''')\n```";
    const calls = parseTextToolCalls(text, tools, opts);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(calls[0].input.path).toBe('calculator.py');
    expect(calls[0].input.content).toContain('def add(a, b):\n  return a + b');
    expect(calls[0].input.content).toContain('raise ValueError("Cannot divide by zero")');
  });

  it('still protects a python fence that is real code, not a call carrier', () => {
    const text = '```python\nx = 1\nresult = read_file(path="data.csv")\n```';
    expect(parseTextToolCalls(text, tools, opts)).toEqual([]);
  });

  it('coerceArgValue unwraps triple-quoted literals raw', () => {
    expect(coerceArgValue("'''line1\nline2'''")).toBe('line1\nline2');
    expect(coerceArgValue('"""a "quoted" bit"""')).toBe('a "quoted" bit');
  });

  it('splitTopLevelArgs does not split on commas inside triple quotes', () => {
    const parts = splitTopLevelArgs("path=\"a.py\", content='''f(a, b)\ng(c, d)'''");
    expect(parts).toHaveLength(2);
  });
});

describe('synthesizeFenceWrite (campaign shape: complete file printed, nothing called)', () => {
  const toolNames = new Set(['write_file', 'read_file']);
  const userMsg = 'Now add multiply(a, b) and divide(a, b) to calculator.py. divide must raise ValueError.';
  const fenceTurn =
    "Let's update `calculator.py`:\n```python\ndef add(a, b):\n  return a + b\n\ndef multiply(a, b):\n  return a * b\n```\nNow, let's write this to the file:\n```python\n```\n";

  it('synthesizes write_file from the largest edit-shaped fence when the target is unambiguous', () => {
    const synth = synthesizeFenceWrite(fenceTurn, userMsg, toolNames);
    expect(synth).not.toBeNull();
    expect(synth!.input.path).toBe('calculator.py');
    expect(synth!.input.content).toContain('def multiply(a, b):');
    expect(synth!.input.content.endsWith('\n')).toBe(true);
  });

  it('does not fire when the user message names no file or several files', () => {
    expect(synthesizeFenceWrite(fenceTurn, 'add the functions please', toolNames)).toBeNull();
    expect(synthesizeFenceWrite(fenceTurn, 'update calculator.py and test_calculator.py', toolNames)).toBeNull();
  });

  it('does not fire on a fence whose language disagrees with the target extension', () => {
    const tsFence = '```typescript\nexport const x = 1;\nexport const y = 2;\n```';
    expect(synthesizeFenceWrite(tsFence, 'update calculator.py with constants', toolNames)).toBeNull();
  });

  it('leaves call-carrier fences to the call-expression parser', () => {
    const carrier = '```python\nwrite_file(path="calculator.py", content="x = 1")\n```';
    expect(synthesizeFenceWrite(carrier, 'update calculator.py', toolNames)).toBeNull();
  });

  it('does not fire without write_file in the catalog', () => {
    expect(synthesizeFenceWrite(fenceTurn, userMsg, new Set(['read_file']))).toBeNull();
  });
});

describe('synthesizeFenceWrite — self-import clobber guard (probe r1, 2026-07-21)', () => {
  const toolNames = new Set(['write_file']);

  it('rejects a fence that imports the target module — test code is not the module', () => {
    const testFence =
      '```python\nimport unittest\nfrom calculator import add, subtract, multiply, divide\n\nclass TestCalculator(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n```';
    expect(synthesizeFenceWrite(testFence, 'Now add multiply and divide to calculator.py.', toolNames)).toBeNull();
  });

  it('rejects the JS require/import forms too', () => {
    const jsFence = "```javascript\nconst { add } = require('./stats');\nconsole.log(add(1, 2));\n```";
    expect(synthesizeFenceWrite(jsFence, 'extend stats.js with a mean function', toolNames)).toBeNull();
    const esmFence = "```javascript\nimport { add } from './stats.js';\nconsole.log(add(1, 2));\n```";
    expect(synthesizeFenceWrite(esmFence, 'extend stats.js with a mean function', toolNames)).toBeNull();
  });

  it('still accepts the module itself — defining code does not import itself', () => {
    const moduleFence = '```python\ndef add(a, b):\n  return a + b\n\ndef multiply(a, b):\n  return a * b\n```';
    const synth = synthesizeFenceWrite(moduleFence, 'Now add multiply to calculator.py.', toolNames);
    expect(synth).not.toBeNull();
    expect(synth!.input.path).toBe('calculator.py');
  });

  it('falls back to a non-importing fence when both are present', () => {
    const both =
      '```python\ndef add(a, b):\n  return a + b\n\ndef multiply(a, b):\n  return a * b\n```\nand the tests:\n' +
      '```python\nimport unittest\nfrom calculator import add\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n```';
    const synth = synthesizeFenceWrite(both, 'Now add multiply to calculator.py.', toolNames);
    expect(synth).not.toBeNull();
    expect(synth!.input.content).toContain('def multiply');
    expect(synth!.input.content).not.toContain('unittest');
  });
});

describe('synthesizeFenceWrite — test-target coherence (campaign 3, ministral r1-on)', () => {
  const toolNames = new Set(['write_file']);

  it('rejects module code aimed at a test file', () => {
    // Live shape: asked to write test_calculator.py, the model printed the
    // calculator MODULE; the synthesizer wrote module code into the test file.
    const moduleFence = '```python\ndef add(a, b):\n  return a + b\n\ndef subtract(a, b):\n  return a - b\n```';
    expect(
      synthesizeFenceWrite(moduleFence, 'Write test_calculator.py with one test per operation.', toolNames),
    ).toBeNull();
  });

  it('accepts a real test fence for a test target', () => {
    const testFence = '```python\nimport calculator\n\ndef test_add():\n    assert calculator.add(2, 3) == 5\n```';
    const synth = synthesizeFenceWrite(testFence, 'Write test_calculator.py with one test per operation.', toolNames);
    expect(synth).not.toBeNull();
    expect(synth!.input.path).toBe('test_calculator.py');
  });

  it('accepts a fence that references the subject module even without test keywords', () => {
    const fence = '```python\nfrom calculator import add\nprint(add(1, 2) == 3)\n```';
    expect(synthesizeFenceWrite(fence, 'Write test_calculator.py checks.', toolNames)).not.toBeNull();
  });

  it('applies no constraint to non-test targets', () => {
    const moduleFence = '```python\ndef add(a, b):\n  return a + b\n\ndef mul(a, b):\n  return a * b\n```';
    expect(synthesizeFenceWrite(moduleFence, 'update calculator.py with the functions', toolNames)).not.toBeNull();
  });
});
