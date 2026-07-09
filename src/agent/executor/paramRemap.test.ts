import { describe, it, expect } from 'vitest';
import { remapParamSynonyms } from './paramRemap.js';

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

  it('only fires for REQUIRED keys — optional canonical keys are left alone', () => {
    const schema = {
      type: 'object' as const,
      properties: { path: { type: 'string' }, query: { type: 'string' } },
      required: ['path'],
    };
    const out = remapParamSynonyms({ path: 'a.ts', q: 'needle' }, schema);
    expect(out.input).toEqual({ path: 'a.ts', q: 'needle' });
    expect(out.notes).toEqual([]);
  });

  it('ignores null/undefined synonym values and non-object input', () => {
    expect(remapParamSynonyms({ file: null, content: 'x' }, WRITE_FILE_SCHEMA).notes).toEqual([]);
    expect(remapParamSynonyms(undefined, WRITE_FILE_SCHEMA).notes).toEqual([]);
    expect(remapParamSynonyms('not-an-object', WRITE_FILE_SCHEMA).notes).toEqual([]);
    expect(remapParamSynonyms([1, 2], WRITE_FILE_SCHEMA).notes).toEqual([]);
  });

  it('no-ops on schema-less or required-less tools', () => {
    expect(remapParamSynonyms({ file: 'a.ts' }, undefined).notes).toEqual([]);
    expect(
      remapParamSynonyms({ file: 'a.ts' }, { type: 'object', properties: { path: { type: 'string' } } }).notes,
    ).toEqual([]);
  });

  it('does not mutate the original input object', () => {
    const input = { file: 'out/f1.md', content: 'x' };
    remapParamSynonyms(input, WRITE_FILE_SCHEMA);
    expect(input).toEqual({ file: 'out/f1.md', content: 'x' });
  });
});
