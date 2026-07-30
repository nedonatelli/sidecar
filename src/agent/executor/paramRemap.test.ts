import { describe, it, expect } from 'vitest';
import { remapParamSynonyms, coerceParamTypes } from './paramRemap.js';

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
