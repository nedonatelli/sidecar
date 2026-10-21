import { describe, it, expect } from 'vitest';
import { remapParamSynonyms, coerceParamTypes, stripEchoedCarriageReturns } from './paramRemap.js';
import { shellTools } from '../tools/shell.js';
import { gitTools } from '../tools/git.js';
import { databaseTools } from '../tools/database.js';
import { fsTools } from '../tools/fs.js';
import type { ToolDefinition } from '../../ollama/types.js';

type ToolInputSchema = ToolDefinition['input_schema'];

const WRITE_FILE_SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string' }, content: { type: 'string' } },
  required: ['path', 'content'],
};

const EDIT_FILE_SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } },
  required: ['path', 'search', 'replace'],
};

describe('remapParamSynonyms', () => {
  it("remaps write_file 'file' onto the missing required 'path' (the llama3.2 pattern)", () => {
    const out = remapParamSynonyms({ file: 'out/f1.md', content: 'k4q9-alpha' }, WRITE_FILE_SCHEMA);
    expect(out.input).toEqual({ path: 'out/f1.md', content: 'k4q9-alpha' });
    expect(out.notes).toHaveLength(1);
    expect(out.notes[0]).toContain("'file'");
    expect(out.notes[0]).toContain("'path'");
  });

  it('remaps multiple missing keys in one call (old_string/new_string → search/replace)', () => {
    const out = remapParamSynonyms(
      { path: 'a.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' },
      EDIT_FILE_SCHEMA,
    );
    expect(out.input).toEqual({ path: 'a.ts', search: 'const x = 1;', replace: 'const x = 2;' });
    expect(out.notes).toHaveLength(2);
  });

  it('never fires when the canonical key is already present', () => {
    const input = { path: 'a.ts', content: 'x', file: 'DECOY.ts' };
    const out = remapParamSynonyms(input, WRITE_FILE_SCHEMA);
    expect(out.input).toBe(input);
    expect(out.notes).toEqual([]);
  });

  it('never steals a synonym that is a declared property of the tool', () => {
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' }, file: { type: 'string' } },
      required: ['path'],
    };
    const out = remapParamSynonyms({ file: 'legit-param.ts' }, schema);
    expect(out.input).toEqual({ file: 'legit-param.ts' });
    expect(out.notes).toEqual([]);
  });

  it('fires for declared OPTIONAL keys too (ask_user q→question fallthrough)', () => {
    const schema = {
      type: 'object' as const,
      properties: { question: { type: 'string' }, options: { type: 'array' } },
      required: [] as string[],
    };
    const out = remapParamSynonyms({ q: 'Which file did you mean?' }, schema);
    expect(out.input).toEqual({ question: 'Which file did you mean?' });
    expect(out.notes).toHaveLength(1);
  });

  it('a single synonym key is consumed once — required key wins over optional', () => {
    const schema = {
      type: 'object' as const,
      properties: { query: { type: 'string' }, question: { type: 'string' } },
      required: ['query'],
    };
    const out = remapParamSynonyms({ q: 'needle' }, schema);
    expect(out.input).toEqual({ query: 'needle' });
    expect(out.notes).toHaveLength(1);
  });

  it('ignores null/undefined synonym values and non-object input', () => {
    expect(remapParamSynonyms({ file: null, content: 'x' }, WRITE_FILE_SCHEMA).notes).toEqual([]);
    expect(remapParamSynonyms(undefined, WRITE_FILE_SCHEMA).notes).toEqual([]);
    expect(remapParamSynonyms('not-an-object', WRITE_FILE_SCHEMA).notes).toEqual([]);
    expect(remapParamSynonyms([1, 2], WRITE_FILE_SCHEMA).notes).toEqual([]);
  });

  it('no-ops on schema-less tools; fires on declared-but-optional keys', () => {
    expect(remapParamSynonyms({ file: 'a.ts' }, undefined).notes).toEqual([]);
    const optionalOnly = remapParamSynonyms(
      { file: 'a.ts' },
      {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    );
    expect(optionalOnly.input).toEqual({ path: 'a.ts' });
    expect(optionalOnly.notes).toHaveLength(1);
  });

  it('remaps the COMPLETE synonym table (mutation-tested — every entry pinned)', () => {
    const cases: Array<[string, string]> = [
      ['file', 'path'],
      ['filename', 'path'],
      ['file_path', 'path'],
      ['filepath', 'path'],
      ['file_name', 'path'],
      ['text', 'content'],
      ['contents', 'content'],
      ['body', 'content'],
      ['file_content', 'content'],
      ['new_content', 'content'],
      ['cmd', 'command'],
      ['shell_command', 'command'],
      ['script', 'command'],
      ['old_string', 'search'],
      ['old_text', 'search'],
      ['find', 'search'],
      ['new_string', 'replace'],
      ['new_text', 'replace'],
      ['replacement', 'replace'],
      ['q', 'query'],
      ['search_query', 'query'],
      ['regex', 'pattern'],
      ['glob', 'pattern'],
      ['q', 'question'],
    ];
    for (const [syn, canonical] of cases) {
      const schema = {
        type: 'object' as const,
        properties: { [canonical]: { type: 'string' } },
        required: [canonical],
      };
      const out = remapParamSynonyms({ [syn]: 'VALUE' }, schema);
      expect(out.input, `${syn} → ${canonical}`).toEqual({ [canonical]: 'VALUE' });
      expect(out.notes, `${syn} → ${canonical} note`).toHaveLength(1);
    }
  });

  it('the disclosure note names both the wrong and the canonical key', () => {
    const out = remapParamSynonyms(
      { file: 'a.ts', content: 'x' },
      {
        type: 'object' as const,
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    );
    expect(out.notes[0]).toContain("'file' is not valid");
    expect(out.notes[0]).toContain("interpreted as 'path'");
    expect(out.notes[0]).toContain("use 'path' next time");
  });

  it('does not mutate the original input object', () => {
    const input = { file: 'out/f1.md', content: 'x' };
    remapParamSynonyms(input, WRITE_FILE_SCHEMA);
    expect(input).toEqual({ file: 'out/f1.md', content: 'x' });
  });
});

describe('coerceParamTypes (string → array, the recurring ask_user bounce)', () => {
  const ASK_SCHEMA = {
    type: 'object' as const,
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    required: ['question'],
  };

  it('wraps a bare string into a one-element array', () => {
    const out = coerceParamTypes({ question: 'Proceed?', options: 'Yes' }, ASK_SCHEMA);
    expect(out.input).toEqual({ question: 'Proceed?', options: ['Yes'] });
    expect(out.notes).toHaveLength(1);
  });

  it('parses a stringified JSON array literal', () => {
    const out = coerceParamTypes({ question: 'Which?', options: '["OAuth", "Password"]' }, ASK_SCHEMA);
    expect(out.input.options).toEqual(['OAuth', 'Password']);
  });

  it('keeps the wrap when the bracketed string is not valid JSON', () => {
    const out = coerceParamTypes({ question: 'Which?', options: '[not json' }, ASK_SCHEMA);
    expect(out.input.options).toEqual(['[not json']);
  });

  it('never touches correctly-typed arrays or non-array params', () => {
    const input = { question: 'x', options: ['a', 'b'] };
    const out = coerceParamTypes(input, ASK_SCHEMA);
    expect(out.input).toBe(input);
    expect(out.notes).toEqual([]);
  });
});

// #249: XML-form calls (`<parameter=k>v</parameter>`) deliver every value as a
// string, and tools read booleans loosely. Each row uses the REAL tool schema.
describe('coerceParamTypes: strings for declared booleans and numbers (#249)', () => {
  const schemaOf = (name: string): ToolInputSchema => {
    const t = [...shellTools, ...gitTools, ...databaseTools, ...fsTools].find((x) => x.definition.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.definition.input_schema;
  };

  it.each([
    // db_migrate_up checks `=== true`: "true" ran the migration instead of the preview.
    ['db_migrate_up', 'dry_run', 'true', true],
    // run_command checks `if (input.background)`: "false" is truthy.
    ['run_command', 'background', 'false', false],
    // git_pull checks `if (input.rebase)`: "false" rebased.
    ['git_pull', 'rebase', 'false', false],
    // edit_file checks `=== true`: "true" was ignored.
    ['edit_file', 'replace_all', 'true', true],
    ['edit_file', 'replace_all', ' TRUE ', true],
  ])('%s %s=%j reaches the tool as %j', (tool, key, raw, expected) => {
    expect((schemaOf(tool).properties?.[key] as { type?: string }).type).toBe('boolean');
    const out = coerceParamTypes({ [key]: raw }, schemaOf(tool));
    expect(out.input[key]).toBe(expected);
    // Logged, not shown to the model: an XML-form model can't write a typed value.
    expect(out.notes).toEqual([]);
    expect(out.logOnly?.[0]).toContain(`'${key}' expects a boolean`);
  });

  it('a numeric string becomes a number; integer schemas refuse fractions', () => {
    const schema = {
      type: 'object' as const,
      properties: { start_line: { type: 'number' }, count: { type: 'integer' } },
    };
    expect(coerceParamTypes({ start_line: ' 5 ', count: '3' }, schema).input).toEqual({ start_line: 5, count: 3 });
    expect(coerceParamTypes({ count: '2.5' }, schema).input).toEqual({ count: '2.5' });
  });

  it('leaves an ambiguous string alone, so validation and the tool still see it', () => {
    const schema = { type: 'object' as const, properties: { flag: { type: 'boolean' }, n: { type: 'number' } } };
    for (const input of [{ flag: 'yes' }, { flag: '1' }, { n: '5a' }, { n: '' }, { n: 'Infinity' }]) {
      const out = coerceParamTypes(input, schema);
      expect(out.input).toBe(input);
      expect(out.logOnly).toBeUndefined();
    }
  });

  it('native calls with real booleans and numbers are untouched', () => {
    const input = { background: false, timeout: 30 };
    const out = coerceParamTypes(input, schemaOf('run_command'));
    expect(out.input).toBe(input);
    expect(out.logOnly).toBeUndefined();
  });
});

describe('V2 insert convention protection (campaign 5 regression)', () => {
  // The edit_file V1 schema — new_text is NOT declared, replace is.
  const v1Schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      search: { type: 'string' },
      replace: { type: 'string' },
      insert_before: { type: 'string' },
      insert_after: { type: 'string' },
    },
    required: ['path'],
  } as never;

  it('remaps new_text to replace even alongside a stale insert field', () => {
    // insert_* is gone from the schema. A model still emitting the old V2 shape
    // from habit should have its payload routed to `replace`, where the
    // missing-`search` inference can act on it — not blocked, which would
    // dead-end on a field edit_file no longer declares.
    const out = remapParamSynonyms({ path: 'a.ts', insert_after: 'anchor', new_text: 'code' }, EDIT_FILE_SCHEMA);
    expect(out?.input.replace).toBe('code');
    expect((out?.notes ?? []).join(' ')).toContain('new_text');
  });

  it('still remaps new_text to replace for Claude-style search/replace emissions', () => {
    const input = { path: 'calc.py', search: 'old line', new_text: 'new line' };
    const { input: out, notes } = remapParamSynonyms(input, v1Schema);
    expect(out.replace).toBe('new line');
    expect(out.new_text).toBeUndefined();
    expect(notes.length).toBe(1);
  });
});

// ministral-3 sent edit_file's search/replace as arrays of lines (5 calls in a
// week of eval runs), each bounced with "must be a string, got array".
describe('coerceParamTypes — line arrays for multi-line text', () => {
  const editSchema = {
    type: 'object' as const,
    properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } },
    required: ['path', 'search', 'replace'],
  };

  it('joins an array of strings with line breaks, and says so', () => {
    const r = coerceParamTypes({ path: 'a.ts', search: ['a', '  b'], replace: ['a', '  c'] }, editSchema);
    expect(r.input).toEqual({ path: 'a.ts', search: 'a\n  b', replace: 'a\n  c' });
    expect(r.notes).toEqual([
      "parameter 'search' expects a string — the array of 2 lines was joined with line breaks",
      "parameter 'replace' expects a string — the array of 2 lines was joined with line breaks",
    ]);
  });

  it('leaves a non-text string param, a mixed array and an empty array to the validator', () => {
    const r = coerceParamTypes({ path: ['a.ts'], search: ['a', 1], replace: [] }, editSchema);
    expect(r.input).toEqual({ path: ['a.ts'], search: ['a', 1], replace: [] });
    expect(r.notes).toEqual([]);
  });
});

// #155 (ML-02): gemma4:e4b echoes each carriage return it read as the literal
// text <0x0D>. On the SWE canary 1,221 multi-line searches carried it and none
// wrote; in `replace` it was written into files. Cases from the investigation.
describe('stripEchoedCarriageReturns', () => {
  it('removes the token before line breaks in search and replace, and says so', () => {
    const r = stripEchoedCarriageReturns({
      path: 'pkg/mod.py',
      search: '    if domain:<0x0D>\n        return 1',
      replace: '    if domain:<0x0D>\n        return 2',
    });
    expect(r.input).toEqual({
      path: 'pkg/mod.py',
      search: '    if domain:\n        return 1',
      replace: '    if domain:\n        return 2',
    });
    expect(r.notes).toHaveLength(2);
    expect(r.notes[0]).toMatch(/'search' contained the literal text <0x0D>/);
  });

  it('removes it at the very end, and from write_file content', () => {
    expect(stripEchoedCarriageReturns({ content: 'name = pkg<0x0D>\nversion = 1.1<0x0D>' }).input).toEqual({
      content: 'name = pkg\nversion = 1.1',
    });
  });

  it('the recorded seaborn shape: a comment line ending in the token', () => {
    const replace =
      '    # This class implements the Stat interface, exposing the _fit_predict method.<0x0D>\n' +
      '    # Other stats should adopt this pattern.';
    expect(stripEchoedCarriageReturns({ replace }).input).toEqual({
      replace:
        '    # This class implements the Stat interface, exposing the _fit_predict method.\n    # Other stats should adopt this pattern.',
    });
  });

  it('keeps <0x0D> that is not at a line end, and leaves other params alone', () => {
    const input = { path: 'a<0x0D>', search: 'the byte <0x0D> is CR', replace: 'x' };
    const r = stripEchoedCarriageReturns(input);
    expect(r.input).toBe(input);
    expect(r.notes).toEqual([]);
  });
});
