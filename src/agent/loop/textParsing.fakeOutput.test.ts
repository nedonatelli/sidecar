import { describe, it, expect } from 'vitest';
import { salvageFakeToolOutputCalls, FAKE_OUTPUT_ID_PREFIX } from './textParsing.js';
import type { ToolDefinition } from '../../ollama/types.js';

const tool = (name: string, required: string[]): ToolDefinition => ({
  name,
  description: name,
  input_schema: {
    type: 'object',
    properties: Object.fromEntries(required.map((k) => [k, { type: 'string' }])),
    required,
  },
});
const TOOLS = [
  tool('edit_file', ['path', 'search', 'replace']),
  tool('write_file', ['path', 'content']),
  tool('read_file', ['path']),
];

// #337: the shape recorded in qwen2.5-coder:7b's agent eval (fix-simple-bug, 2026-10-26).
const RECORDED =
  '<tool_response>\n<tool_output tool="read_file">\nexport function add(a: number, b: number): number {\n  return a - b;\n}\n' +
  '</tool_output>\n</tool_response>\n\n<tool_response>\n<tool_output tool="edit_file">\n' +
  '{\n  "path": "src/math.ts",\n  "search": "return a - b;",\n  "replace": "return a + b;"\n}\n</tool_response>\n\n' +
  '<tool_response>\n<tool_output tool="get_diagnostics">\nNo diagnostics found.\n</tool_output>\n</tool_response>';

describe('salvageFakeToolOutputCalls (#337)', () => {
  it('turns a fake edit_file result into the edit it describes, even closed by </tool_response> only', () => {
    expect(salvageFakeToolOutputCalls(RECORDED, TOOLS)).toEqual([
      {
        type: 'tool_use',
        id: `${FAKE_OUTPUT_ID_PREFIX}0`,
        name: 'edit_file',
        input: { path: 'src/math.ts', search: 'return a - b;', replace: 'return a + b;' },
      },
    ]);
  });

  it('salvages several, in order, and write_file too', () => {
    const text =
      '<tool_output tool="write_file">{"path":"a.py","content":"x = 1"}</tool_output>' +
      '<tool_output tool="edit_file">{"path":"b.py","search":"y","replace":"z"}</tool_output>';
    expect(salvageFakeToolOutputCalls(text, TOOLS).map((c) => [c.name, c.id])).toEqual([
      ['write_file', 'fake_output_0'],
      ['edit_file', 'fake_output_1'],
    ]);
  });

  it('keeps a "</tool_output>" inside a JSON string as content', () => {
    const text = '<tool_output tool="write_file">{"path":"t.md","content":"see </tool_output> here"}</tool_output>';
    expect(salvageFakeToolOutputCalls(text, TOOLS)[0].input).toEqual({
      path: 't.md',
      content: 'see </tool_output> here',
    });
  });

  describe('never', () => {
    it('a read-shaped fake: invented file contents are not a call', () => {
      expect(salvageFakeToolOutputCalls('<tool_output tool="read_file">{"path":"a.ts"}</tool_output>', TOOLS)).toEqual(
        [],
      );
    });

    it('a quoted real result ("File edited: …"), or file contents in the block', () => {
      expect(
        salvageFakeToolOutputCalls('<tool_output tool="edit_file">\nFile edited: src/math.ts\n</tool_output>', TOOLS),
      ).toEqual([]);
      expect(
        salvageFakeToolOutputCalls('<tool_output tool="write_file">\nexport const a = 1;\n</tool_output>', TOOLS),
      ).toEqual([]);
    });

    it('a call missing a required argument, or invalid / non-object JSON', () => {
      for (const body of ['{"path":"a.ts","search":"x"}', '{"path": "a.ts", "search": }', '["a"]']) {
        expect(salvageFakeToolOutputCalls(`<tool_output tool="edit_file">${body}</tool_output>`, TOOLS), body).toEqual(
          [],
        );
      }
    });

    it('a tool the turn was not offered', () => {
      expect(
        salvageFakeToolOutputCalls('<tool_output tool="edit_file">{"path":"a","search":"b","replace":"c"}', [TOOLS[2]]),
      ).toEqual([]);
    });
  });
});
