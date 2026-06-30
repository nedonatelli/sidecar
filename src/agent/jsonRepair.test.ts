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
});
