import { describe, it, expect } from 'vitest';
import { parseTextToolCalls, parseTextToolCallsCleaned } from './textParsing.js';
import type { ToolDefinition } from '../../ollama/types.js';

// #250: a model on text-format tool calls was shown the `<tool_call>` format,
// so it also writes the tag when it QUOTES a call. These fixtures pin what runs.

function tool(name: string, properties: Record<string, unknown> = {}): ToolDefinition {
  return { name, description: name, input_schema: { type: 'object', properties, required: [] } };
}

const TOOLS = [tool('read_file'), tool('edit_file'), tool('write_file'), tool('grep'), tool('run_command')];
const FALLBACK = { textToolFallback: true };
const RUN = '<tool_call>{"name": "run_command", "arguments": {"command": "rm -rf build"}}</tool_call>';

function names(text: string, opts: Parameters<typeof parseTextToolCalls>[2] = FALLBACK): string[] {
  return parseTextToolCalls(text, TOOLS, opts).map((c) => c.name);
}

describe('text-format tool calls (#250)', () => {
  it('runs a call written on its own line, and cuts it from the reply', () => {
    const text = `I'll read the file first.\n<tool_call>{"name": "read_file", "arguments": {"path": "src/a.ts"}}</tool_call>`;
    const { calls, cleanedText } = parseTextToolCallsCleaned(text, TOOLS, FALLBACK);
    expect(calls.map((c) => [c.name, c.input])).toEqual([['read_file', { path: 'src/a.ts' }]]);
    expect(cleanedText).toBe("I'll read the file first.");
  });

  it('runs several calls in one reply, in order', () => {
    const text =
      '<tool_call>{"name": "grep", "arguments": {"pattern": "TODO"}}</tool_call>\n' +
      '<tool_call>{"name": "read_file", "arguments": {"path": "b.ts"}}</tool_call>';
    expect(names(text)).toEqual(['grep', 'read_file']);
  });

  describe('booleans and numbers keep their types', () => {
    it('in a call', () => {
      const text =
        '<tool_call>{"name": "edit_file", "arguments": {"path": "a.py", "search": "x", "replace": "y", "replace_all": true}}</tool_call>\n' +
        '<tool_call>{"name": "run_command", "arguments": {"command": "pytest", "timeout": 300, "background": false}}</tool_call>';
      const [edit, run] = parseTextToolCalls(text, TOOLS, FALLBACK);
      expect(edit.input.replace_all).toBe(true);
      expect(run.input.timeout).toBe(300);
      expect(run.input.background).toBe(false);
    });

    it('in a string that looks like one', () => {
      const text = '<tool_call>{"name": "write_file", "arguments": {"path": "v.txt", "content": "true"}}</tool_call>';
      expect(parseTextToolCalls(text, TOOLS, FALLBACK)[0].input.content).toBe('true');
    });
  });

  describe('a call in a code example does not run', () => {
    it('in a fenced block', () => {
      const text = `To clean the build you would run:\n\`\`\`\n${RUN}\n\`\`\`\nShall I?`;
      expect(names(text)).toEqual([]);
    });

    it('in a fenced block with its close tag missing: the JSON is not read as a bare call either', () => {
      const text = `Example:\n\`\`\`\n<tool_call>{"name": "run_command", "arguments": {"command": "rm -rf build"}}\n\`\`\``;
      expect(names(text)).toEqual([]);
    });

    it('in inline code', () => {
      expect(names(`The format is \`${RUN}\`, one per call.`)).toEqual([]);
    });

    it('while a real call after the example still runs', () => {
      const text = `For instance:\n\`\`\`\n${RUN}\n\`\`\`\n<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>`;
      expect(names(text)).toEqual(['read_file']);
    });

    it('is unchanged on the native path, where a fenced tag still runs', () => {
      // The option is only set for text-format turns; every other model keeps
      // the parser it had.
      expect(names(`\`\`\`\n${RUN}\n\`\`\``, {})).toEqual(['run_command']);
    });
  });

  describe('a call quoted in prose does not run', () => {
    it('cited as already made', () => {
      expect(names(`I called ${RUN} which confirmed the directory is gone.`)).toEqual([]);
    });

    it('offered as an option', () => {
      expect(names(`If you want, I could run ${RUN} next.`)).toEqual([]);
    });

    it('given as an example', () => {
      expect(names(`For example: ${RUN}`)).toEqual([]);
    });

    it('repeated from a file the model read', () => {
      expect(names(RUN, { ...FALLBACK, echoSource: `README says:\n${RUN}\n` })).toEqual([]);
    });
  });

  describe('a cut-off call does not run', () => {
    it('when the object never closes', () => {
      const text =
        'Writing it now.\n<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "def f():\\n    return';
      expect(parseTextToolCalls(text, TOOLS, FALLBACK)).toEqual([]);
    });

    it('when a close tag follows an object that never closed', () => {
      const text = '<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "x"</tool_call>';
      expect(parseTextToolCalls(text, TOOLS, FALLBACK)).toEqual([]);
    });

    it('while a closed but malformed call still goes to repair', () => {
      const text = '<tool_call>{"name": "write_file", "arguments": {"path": "a.py", "content": "a\nb"}}</tool_call>';
      const [call] = parseTextToolCalls(text, TOOLS, FALLBACK);
      expect(call.name).toBe('write_file');
      expect(call._malformedInputRaw).toBeDefined();
    });
  });

  it('a closed call with its close tag missing still runs', () => {
    // The streaming parser's rule (#246): the object closed, so the call is whole.
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}\nThen I will fix it.';
    expect(names(text)).toEqual(['read_file']);
  });
});
