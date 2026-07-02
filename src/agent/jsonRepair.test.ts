import { describe, it, expect } from 'vitest';
import { tryJsonRepair } from './jsonRepair.js';

describe('tryJsonRepair', () => {
  it('passes through already-valid JSON', () => {
    expect(tryJsonRepair('{"path":"a.ts","line":3}')).toEqual({ path: 'a.ts', line: 3 });
  });

  it('extracts an object embedded in prose', () => {
    expect(tryJsonRepair('Sure, here you go: {"path":"a.ts"} done')).toEqual({ path: 'a.ts' });
  });

  it('strips a code fence', () => {
    expect(tryJsonRepair('```json\n{"path":"a.ts"}\n```')).toEqual({ path: 'a.ts' });
  });

  it('drops trailing commas', () => {
    expect(tryJsonRepair('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('quotes bare keys', () => {
    expect(tryJsonRepair('{path: "a.ts", line: 3}')).toEqual({ path: 'a.ts', line: 3 });
  });

  it('converts Python literals', () => {
    expect(tryJsonRepair('{"recursive": True, "hidden": False, "limit": None}')).toEqual({
      recursive: true,
      hidden: false,
      limit: null,
    });
  });

  it('converts single-quoted strings', () => {
    expect(tryJsonRepair("{'path': 'a.ts'}")).toEqual({ path: 'a.ts' });
  });

  it('normalizes smart quotes', () => {
    expect(tryJsonRepair('{“path”: “a.ts”}')).toEqual({ path: 'a.ts' });
  });

  it('balances a truncated object', () => {
    expect(tryJsonRepair('{"path":"a.ts","opts":{"deep":true')).toEqual({ path: 'a.ts', opts: { deep: true } });
  });

  it('balances a truncated string + object', () => {
    // The string value is cut off mid-token; balancing closes the string and braces.
    const out = tryJsonRepair('{"path":"a.ts","query":"unclosed');
    expect(out).toMatchObject({ path: 'a.ts' });
  });

  it('returns null for unrecoverable / non-object input', () => {
    expect(tryJsonRepair('not json at all')).toBeNull();
    expect(tryJsonRepair('[1,2,3]')).toBeNull(); // array, not an args object
    expect(tryJsonRepair('')).toBeNull();
  });

  // --- raw control chars inside strings (the coding-tool-call failure) ---

  it('escapes a literal newline inside a multi-line content value', () => {
    // The `\n` here is a REAL newline byte — exactly what a small model emits
    // for a multi-line write_file, and what JSON.parse rejects.
    const raw = '{"path":"f.py","content":"def f():\n    return 1"}';
    expect(tryJsonRepair(raw)).toEqual({ path: 'f.py', content: 'def f():\n    return 1' });
  });

  it('escapes literal tabs and carriage returns inside strings', () => {
    const raw = '{"content":"a\tb\r\nc"}';
    expect(tryJsonRepair(raw)).toEqual({ content: 'a\tb\r\nc' });
  });

  it('preserves formatting newlines OUTSIDE strings (pretty-printed args)', () => {
    const raw = '{\n  "path": "a.ts",\n  "line": 3\n}';
    expect(tryJsonRepair(raw)).toEqual({ path: 'a.ts', line: 3 });
  });

  it('recovers multi-line content that is ALSO truncated', () => {
    const raw = '{"path":"f.py","content":"line1\nline2';
    expect(tryJsonRepair(raw)).toMatchObject({ path: 'f.py' });
    expect((tryJsonRepair(raw) as { content: string }).content.startsWith('line1\nline2')).toBe(true);
  });

  it('maps NaN / Infinity to null (invalid JSON numerics)', () => {
    expect(tryJsonRepair('{"x": NaN, "y": Infinity}')).toEqual({ x: null, y: null });
  });
});
