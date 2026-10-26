import { describe, it, expect } from 'vitest';
import {
  parseThinkTags,
  toFunctionTools,
  parseTextToolCallsStream,
  flushTextToolCallsStream,
  createTextToolCallState,
  abortableRead,
  type ThinkTagState,
  type TextToolCallState,
} from './streamUtils.js';
import type { StreamEvent, ToolDefinition } from './types.js';

const READ_FILE_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const WRITE_FILE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: 'Write a file',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
};

// ---------------------------------------------------------------------------
// parseThinkTags
// ---------------------------------------------------------------------------

describe('parseThinkTags', () => {
  function collect(content: string, state?: ThinkTagState): StreamEvent[] {
    const s = state ?? { insideThinkTag: false };
    return [...parseThinkTags(content, s)];
  }

  it('emits plain text when no think tags present', () => {
    const events = collect('Hello world');
    expect(events).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('parses a complete <think> block in one chunk', () => {
    const events = collect('<think>reasoning</think>answer');
    expect(events).toEqual([
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('handles text before and after think tags', () => {
    const events = collect('before<think>thinking</think>after');
    expect(events).toEqual([
      { type: 'text', text: 'before' },
      { type: 'thinking', thinking: 'thinking' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('handles unclosed think tag across chunks', () => {
    const state: ThinkTagState = { insideThinkTag: false };

    const events1 = [...parseThinkTags('<think>partial', state)];
    expect(events1).toEqual([{ type: 'thinking', thinking: 'partial' }]);
    expect(state.insideThinkTag).toBe(true);

    const events2 = [...parseThinkTags(' more</think>done', state)];
    expect(events2).toEqual([
      { type: 'thinking', thinking: ' more' },
      { type: 'text', text: 'done' },
    ]);
    expect(state.insideThinkTag).toBe(false);
  });

  it('handles empty content', () => {
    const events = collect('');
    expect(events).toEqual([]);
  });

  it('handles think tag with no content', () => {
    const events = collect('<think></think>');
    expect(events).toEqual([]);
  });

  it('handles multiple think blocks', () => {
    const events = collect('a<think>t1</think>b<think>t2</think>c');
    expect(events).toEqual([
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 't1' },
      { type: 'text', text: 'b' },
      { type: 'thinking', thinking: 't2' },
      { type: 'text', text: 'c' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// toFunctionTools
// ---------------------------------------------------------------------------

describe('toFunctionTools', () => {
  it('converts ToolDefinition[] to function calling format', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ];

    const result = toFunctionTools(tools);
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ]);
  });

  it('handles empty array', () => {
    expect(toFunctionTools([])).toEqual([]);
  });

  it('handles tools without required fields', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'list_dir',
        description: 'List directory',
        input_schema: { type: 'object', properties: {} },
      },
    ];

    const result = toFunctionTools(tools);
    expect(result[0].function.parameters.required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseTextToolCallsStream
// ---------------------------------------------------------------------------

describe('parseTextToolCallsStream', () => {
  function feed(chunks: string[], state: TextToolCallState): StreamEvent[] {
    const out: StreamEvent[] = [];
    for (const c of chunks) {
      for (const ev of parseTextToolCallsStream(c, state)) out.push(ev);
    }
    for (const ev of flushTextToolCallsStream(state)) out.push(ev);
    return out;
  }

  it('passes plain text through unchanged', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['Hello world'], state);
    expect(events).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('emits nothing on empty input', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    expect(feed([''], state)).toEqual([]);
  });

  it('intercepts a complete <function=...> block as tool_use', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<function=read_file><parameter=path>package.json</parameter></function>'], state);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool_use',
      toolUse: {
        type: 'tool_use',
        id: expect.stringMatching(/^stream_tc_/),
        name: 'read_file',
        input: { path: 'package.json' },
      },
    });
  });

  it('suppresses the raw XML from the text stream', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['before <function=read_file><parameter=path>a.ts</parameter></function> after'], state);
    const textParts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(textParts.join('')).toBe('before  after');
    expect(events.some((e) => e.type === 'tool_use')).toBe(true);
  });

  it('handles a tool-call block split across chunks', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<function=read_', 'file><parameter=path>', 'index.ts</parameter>', '</function>'], state);
    const toolUses = events.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    const tu0 = toolUses[0] as unknown as { toolUse: { input: Record<string, unknown> } };
    expect(tu0.toolUse.input).toEqual({ path: 'index.ts' });
    // No text should leak from inside the block
    const textParts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(textParts.join('')).toBe('');
  });

  it('holds back a partial start marker across chunk boundaries', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    // First chunk ends mid-marker — we should not emit the '<' prefix yet
    const out1 = [...parseTextToolCallsStream('hello <func', state)];
    expect(out1).toEqual([{ type: 'text', text: 'hello ' }]);
    // Second chunk completes the marker and body
    const out2 = [...parseTextToolCallsStream('tion=read_file><parameter=path>a.ts</parameter></function>', state)];
    expect(out2.filter((e) => e.type === 'tool_use')).toHaveLength(1);
    expect(out2.filter((e) => e.type === 'text')).toHaveLength(0);
  });

  it('falls through unknown tool names as plain text', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<function=ghost>nope</function>'], state);
    const textParts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(textParts.join('')).toBe('<function=ghost>nope</function>');
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
  });

  it('intercepts <tool_call>JSON</tool_call> format', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>'], state);
    expect(events).toHaveLength(1);
    const ev0 = events[0] as unknown as { toolUse: { name: string; input: Record<string, unknown> } };
    expect(ev0.toolUse).toMatchObject({
      name: 'read_file',
      input: { path: 'a.ts' },
    });
  });

  // #246: these were dropped silently, so a turn could end with nothing at all.
  it('returns a <tool_call> body that is not JSON as text', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<tool_call>not json</tool_call>'], state);
    expect(events).toEqual([{ type: 'text', text: '<tool_call>not json</tool_call>' }]);
  });

  // ML-58 (#164): raw newlines in a JSON string made the call vanish before repair.
  it('hands a malformed <tool_call> naming a known tool on for repair', () => {
    const state = createTextToolCallState([WRITE_FILE_TOOL]);
    const body = '{"name":"write_file","arguments":{"path":"a.py","content":"x = 1\ny = 2"}}';
    const events = feed([`<tool_call>\n${body}\n</tool_call>`], state);
    expect(events).toHaveLength(1);
    const ev0 = events[0] as unknown as { toolUse: Record<string, unknown> };
    expect(ev0.toolUse).toMatchObject({ name: 'write_file', input: {}, _malformedInputRaw: body });
  });

  // #246: the body's end is found by a string-aware scan, so a </tool_call>
  // inside a string no longer cuts it off: the whole call parses.
  it('parses a body whose string contains </tool_call>', () => {
    const state = createTextToolCallState([WRITE_FILE_TOOL]);
    const events = feed(
      ['<tool_call>{"name":"write_file","arguments":{"path":"a.py","content":"x</tool_call>y"}}</tool_call>'],
      state,
    );
    expect(events).toHaveLength(1);
    expect((events[0] as { toolUse: { input: unknown } }).toolUse.input).toEqual({
      path: 'a.py',
      content: 'x</tool_call>y',
    });
  });

  it('returns a <tool_call> for an unknown tool name as text', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<tool_call>{"name":"nope","arguments":{}}</tool_call>'], state);
    expect(events).toEqual([{ type: 'text', text: '<tool_call>{"name":"nope","arguments":{}}</tool_call>' }]);
  });

  // #246: the issue's three probe inputs, fed in 7-character deltas as the backends receive them.
  describe('streamed in small deltas (#246)', () => {
    const deltas = (s: string, n = 7) =>
      Array.from({ length: Math.ceil(s.length / n) }, (_, i) => s.slice(i * n, i * n + n));
    const run = (s: string) => {
      const state = createTextToolCallState([READ_FILE_TOOL, WRITE_FILE_TOOL]);
      return feed(deltas(s), state);
    };
    const calls = (evs: ReturnType<typeof run>) =>
      evs.filter((e) => e.type === 'tool_use').map((e) => (e as { toolUse: { name: string; input: unknown } }).toolUse);
    const text = (evs: ReturnType<typeof run>) =>
      evs
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join('');

    it('a missing </tool_call> before the next call: both calls dispatch, the turn is not empty', () => {
      const evs = run(
        '<tool_call>{"name":"read_file","arguments":{"path":"a"}}\n' +
          '<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>',
      );
      expect(calls(evs).map((c) => c.input)).toEqual([{ path: 'a' }, { path: 'b' }]);
      expect(text(evs)).not.toContain('<tool_call>');
    });

    it('</tool_call> inside a string: the call dispatches whole and nothing leaks', () => {
      const evs = run(
        `<tool_call>{"name":"write_file","arguments":{"path":"p.py","content":"s='</tool_call>'"}}</tool_call>`,
      );
      expect(calls(evs)).toEqual([expect.objectContaining({ input: { path: 'p.py', content: "s='</tool_call>'" } })]);
      expect(text(evs)).toBe('');
    });

    it('a wrong closing tag: the call is recovered and no markup reaches the reply', () => {
      const evs = run('<tool_call>{"name":"read_file","arguments":{"path":"a"}}</think>');
      expect(calls(evs).map((c) => c.input)).toEqual([{ path: 'a' }]);
      expect(text(evs)).toBe('');
    });

    it('a missing close tag before plain text: the call dispatches and the text is kept', () => {
      const evs = run('<tool_call>{"name":"read_file","arguments":{"path":"a"}} Reading it now.');
      expect(calls(evs).map((c) => c.input)).toEqual([{ path: 'a' }]);
      expect(text(evs)).toBe(' Reading it now.');
    });

    it('a body still open at the end of the stream is returned as text, as before', () => {
      const evs = run('<tool_call>{"name":"read_file","arguments":{"path":"a"');
      expect(calls(evs)).toEqual([]);
      expect(text(evs)).toBe('<tool_call>{"name":"read_file","arguments":{"path":"a"');
    });
  });

  it('handles multiple consecutive tool calls in one chunk', () => {
    const state = createTextToolCallState([READ_FILE_TOOL, WRITE_FILE_TOOL]);
    const events = feed(
      [
        '<function=read_file><parameter=path>a.ts</parameter></function>' +
          '<function=write_file><parameter=path>b.ts</parameter><parameter=content>x</parameter></function>',
      ],
      state,
    );
    const toolUses = events.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
    expect((toolUses[0] as { toolUse: { name: string } }).toolUse.name).toBe('read_file');
    expect((toolUses[1] as { toolUse: { name: string } }).toolUse.name).toBe('write_file');
  });

  it('reproduces the qwen3-coder screenshot case', () => {
    // Mirrors the raw output from the bug report: body split across chunks
    // with an extra stray </tool_call> at the end.
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(
      ['<function=read_file>\n<parameter=path>\npackage.json\n', '</parameter>\n</function>\n</tool_call>'],
      state,
    );
    const toolUses = events.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    const tu = toolUses[0] as unknown as { toolUse: { name: string; input: Record<string, unknown> } };
    expect(tu.toolUse).toMatchObject({
      name: 'read_file',
      input: { path: 'package.json' },
    });
    // The stray </tool_call> should fall through as text, not as a tool call
    const textParts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    // Whatever is emitted as text must not include the intercepted function block
    expect(textParts.join('')).not.toContain('<function=read_file>');
    expect(textParts.join('')).not.toContain('<parameter=path>');
  });

  // ML-64 (#164): values were trim()med, so code lost its first-line indent.
  it('keeps the whitespace of a multi-line parameter value', () => {
    const state = createTextToolCallState([WRITE_FILE_TOOL]);
    const code = '    x = 1\n    y = 2\n\n';
    const events = feed(
      [
        `<function=write_file>\n<parameter=path>\n a.py \n</parameter>\n<parameter=content>\n${code}\n</parameter>\n</function>`,
      ],
      state,
    );
    const tu = events.find((e) => e.type === 'tool_use') as unknown as { toolUse: { input: Record<string, unknown> } };
    expect(tu.toolUse.input).toEqual({ path: 'a.py', content: code });
  });

  it('flushes an unclosed tool-call body as text at stream end', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['<function=read_file><parameter=path>a.ts'], state);
    // Unclosed — body should be recovered as text on flush
    const textParts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(textParts.join('')).toContain('<function=read_file>');
    expect(textParts.join('')).toContain('<parameter=path>a.ts');
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
  });

  it('passes text with incidental < through when no marker forms', () => {
    const state = createTextToolCallState([READ_FILE_TOOL]);
    const events = feed(['a < b and c < d is math'], state);
    const textParts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(textParts.join('')).toBe('a < b and c < d is math');
  });
});

// ---------------------------------------------------------------------------
// abortableRead
// ---------------------------------------------------------------------------

function makeReader(chunks: string[]) {
  let i = 0;
  return {
    read: () => {
      if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
      return Promise.resolve({ done: false, value: new TextEncoder().encode(chunks[i++]) });
    },
    cancel: () => Promise.resolve(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('abortableRead', () => {
  it('reads without signal', async () => {
    const reader = makeReader(['hello']);
    const result = await abortableRead(reader);
    expect(result.done).toBe(false);
    expect(new TextDecoder().decode(result.value)).toBe('hello');
  });

  it('resolves with non-aborted signal', async () => {
    const reader = makeReader(['world']);
    const ac = new AbortController();
    const result = await abortableRead(reader, ac.signal);
    expect(result.done).toBe(false);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const reader = makeReader(['data']);
    const ac = new AbortController();
    ac.abort();
    await expect(abortableRead(reader, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with AbortError when signal fires during read', async () => {
    const ac = new AbortController();
    let resolveRead!: (v: ReadableStreamReadResult<Uint8Array>) => void;
    const reader = {
      read: () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((res) => {
          resolveRead = res;
        }),
      cancel: () => Promise.resolve(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const promise = abortableRead(reader, ac.signal);
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    resolveRead({ done: true, value: undefined });
  });

  it('resolves when read succeeds before signal fires', async () => {
    const ac = new AbortController();
    const reader = makeReader(['ok']);
    const result = await abortableRead(reader, ac.signal);
    expect(result.done).toBe(false);
    ac.abort();
  });
});
