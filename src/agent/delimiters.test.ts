import { describe, it, expect } from 'vitest';
import { findBalancedEnd, delimiterBalance, balanceEquals } from './delimiters.js';

describe('findBalancedEnd (json dialect)', () => {
  const end = (s: string) => findBalancedEnd(s, 0, { dialect: 'json' });

  it('matches the simple and nested cases', () => {
    expect(end('{}')).toBe(1);
    expect(end('{"a":1}')).toBe(6);
    expect(end('{"a":{"b":{"c":1}}}')).toBe(18);
  });

  it('stops at the FIRST balanced close, ignoring trailing text', () => {
    const s = '{"a":1} trailing {"b":2}';
    expect(end(s)).toBe(6);
  });

  it('ignores braces inside string values (the live qwen2.5-coder bug)', () => {
    // A code edit's arguments carry braces. A naive depth count ran off here,
    // decided the object was truncated, and dispatched edit_file({}).
    const s = '{"name":"edit_file","arguments":{"search":"export function greet(): string {","replace":"x {"}}';
    const e = end(s);
    expect(e).toBe(s.length - 1);
    expect(() => JSON.parse(s.slice(0, e + 1))).not.toThrow();
  });

  it('honors escaped quotes and escaped backslashes inside strings', () => {
    const s = '{"a":"say \\"hi\\" {","b":"back\\\\slash {"}';
    const e = end(s);
    expect(e).toBe(s.length - 1);
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it('returns -1 for a truncated object', () => {
    expect(end('{"a":{"b":1}')).toBe(-1);
    expect(end('{"a":"unterminated string {')).toBe(-1);
  });

  it('a brace inside an unterminated string cannot close the object', () => {
    // The string swallows the rest of the input, so nothing closes.
    expect(end('{"a":"} } }')).toBe(-1);
  });

  it('scans from an arbitrary start offset', () => {
    const s = 'prefix noise {"a":1} suffix';
    expect(findBalancedEnd(s, 13, { dialect: 'json' })).toBe(19);
  });
});

describe('delimiterBalance (code dialect)', () => {
  const bal = (s: string) => delimiterBalance(s);

  it('counts real delimiters', () => {
    expect(bal('function f() {')).toEqual({ curly: 1, paren: 0, square: 0 });
    expect(bal('}')).toEqual({ curly: -1, paren: 0, square: 0 });
    expect(bal('const x = [1, (2)];')).toEqual({ curly: 0, paren: 0, square: 0 });
  });

  it('does NOT count delimiters inside string literals (latent false-refusal bug)', () => {
    // The structural guard refuses an inferred edit whose balance differs from
    // the region it replaces. Counting braces inside strings made a legitimate
    // edit look unbalanced — `const s = "{";` reads as +1 curly.
    expect(bal('const s = "{";')).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(bal("const s = '(';")).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(bal('const s = "}}}}";')).toEqual({ curly: 0, paren: 0, square: 0 });
  });

  it('does not count delimiters inside comments', () => {
    expect(bal('// a comment with { and (\ncode();')).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(bal('/* block { ( [ */ x;')).toEqual({ curly: 0, paren: 0, square: 0 });
  });

  it('counts template-literal interpolation braces, but not literal text', () => {
    // `${name}` braces are real source and must balance; the surrounding text
    // (including a literal `{`) is not code.
    expect(bal('return `Hello, ${name}!`;')).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(bal('return `a { b`;')).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(bal('return `${ {a:1} }`;')).toEqual({ curly: 0, paren: 0, square: 0 });
  });

  it('honors escaped quotes inside strings', () => {
    expect(bal('const s = "he said \\"{\\" loudly";')).toEqual({ curly: 0, paren: 0, square: 0 });
  });

  it('reports genuine imbalance', () => {
    expect(bal('function f() {').curly).toBe(1);
    expect(bal('if (x) { return; ').curly).toBe(1);
    expect(bal('  return x;\n}').curly).toBe(-1);
  });

  it('the live corruption: a block HEADER and a self-contained one-liner do NOT balance', () => {
    const header = 'export function greet(name: string): string {';
    const oneLiner = 'function welcome(name: string): string { return `Hello, ${name}!`; }';
    expect(balanceEquals(bal(header), bal(oneLiner))).toBe(false);
  });

  it('a like-for-like header swap DOES balance (the legitimate rename)', () => {
    const before = 'export function greet(name: string): string {';
    const after = 'export function welcome(name: string): string {';
    expect(balanceEquals(bal(before), bal(after))).toBe(true);
  });
});

describe('balanceEquals', () => {
  it('compares all three families', () => {
    expect(balanceEquals({ curly: 1, paren: 0, square: 0 }, { curly: 1, paren: 0, square: 0 })).toBe(true);
    expect(balanceEquals({ curly: 1, paren: 0, square: 0 }, { curly: 1, paren: 1, square: 0 })).toBe(false);
    expect(balanceEquals({ curly: 0, paren: 0, square: 1 }, { curly: 0, paren: 0, square: 0 })).toBe(false);
  });
});
