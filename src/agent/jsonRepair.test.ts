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
  // ---------------------------------------------------------------------------
  // Braces, quotes and escapes INSIDE string values.
  //
  // Stryker found the entire string-aware scanner unkilled: `if (inStr)` → `false`,
  // the `esc` flips, and `c === '\\'` → `c === ""` ALL survived. Nothing fed the
  // repairer a string value containing a brace, a quote, or an escape — so the code
  // that exists precisely to handle them was never exercised.
  //
  // That is not a hypothetical gap. The identical defect in textParsing's bare-JSON
  // scanner — naive brace counting, running the depth off on a `{` inside a string —
  // silently turned a well-formed rename into `edit_file({})`. The model looked like
  // it had chosen not to act. It cost a full dogfood session to find.
  //
  // Every tool call that edits code carries braces in its arguments. This is the
  // common case, not the exotic one.
  // ---------------------------------------------------------------------------

  it('a brace inside a string value does not terminate the object early', () => {
    // The exact textParsing bug: a naive scanner closes the object on the `}` that
    // lives inside the code snippet, and the arguments are lost.
    const raw = '{"path":"a.ts","search":"if (x) { return 1; }","replace":"if (x) { return 2; }"}';
    expect(tryJsonRepair(raw)).toEqual({
      path: 'a.ts',
      search: 'if (x) { return 1; }',
      replace: 'if (x) { return 2; }',
    });
  });

  it('an escaped quote inside a string does not end the string', () => {
    const raw = String.raw`{"content":"console.log(\"hi\");"}`;
    expect(tryJsonRepair(raw)).toEqual({ content: 'console.log("hi");' });
  });

  it('an escaped backslash at the end of a value does not swallow the closing quote', () => {
    // `esc` must RESET after consuming the escaped backslash — otherwise the quote
    // that closes the string is read as escaped and the scanner runs off the end.
    const raw = String.raw`{"sep":"\\","path":"a.ts"}`;
    expect(tryJsonRepair(raw)).toEqual({ sep: '\\', path: 'a.ts' });
  });

  it('recovers a TRUNCATED object whose string value contains braces', () => {
    // Truncation + braces-in-string together: the case a small model actually
    // produces when it runs out of tokens mid-edit.
    const raw = '{"path":"a.ts","content":"function f() { return 1; }';
    expect(tryJsonRepair(raw)).toEqual({ path: 'a.ts', content: 'function f() { return 1; }' });
  });

  it('ignores braces and quotes inside a string when extracting from prose', () => {
    const raw = String.raw`Here: {"code":"const o = {\"k\": 1};"} — done`;
    expect(tryJsonRepair(raw)).toEqual({ code: 'const o = {"k": 1};' });
  });
  it('an UNBALANCED brace inside a string does not run the depth off the end', () => {
    // The discriminating case, and the realistic one: a model opens a block in the
    // `search` value and keeps talking after the JSON. A scanner that counts braces
    // without tracking strings never returns to depth 0, swallows the trailing prose
    // into the object, and the whole call is lost.
    //
    // Balanced braces inside strings do NOT discriminate — a naive counter happens
    // to land on the right byte. It has to be unbalanced to prove the string
    // tracking is doing the work.
    const raw = '{"path":"a.ts","search":"function f() {"} and that is the change I would make';
    expect(tryJsonRepair(raw)).toEqual({ path: 'a.ts', search: 'function f() {' });
  });

  it('an unbalanced CLOSING brace inside a string does not close the object early', () => {
    const raw = '{"path":"a.ts","replace":"  }"} — done, let me know if you want more';
    expect(tryJsonRepair(raw)).toEqual({ path: 'a.ts', replace: '  }' });
  });
});
