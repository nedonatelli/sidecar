import { describe, it, expect } from 'vitest';
import { delimiterBalance } from './delimiters.js';

// ---------------------------------------------------------------------------
// The delimiter heuristic's KNOWN LIMITS, pinned so nobody trusts it further
// than it deserves.
//
// ORACLE: a complete, valid source file must have net-zero delimiter balance.
// Run over real code, this scanner FAILS that oracle:
//     TypeScript   72/900 valid files reported imbalanced  (8%)
//     Rust         58/344                                  (17%)
//     Python       14/400                                  (3.5%)
//
// Each false imbalance is a FALSE REFUSAL of a legitimate edit. That is why the
// heuristic no longer gates edits: the tree-sitter parse does (syntaxCheck.ts),
// and this runs only as a fallback for languages with no grammar, where a rough
// signal beats none.
//
// The cases below are the actual causes, so a future change that "improves" the
// heuristic can prove it against them.
// ---------------------------------------------------------------------------

describe('delimiterBalance: correct on the constructs it models', () => {
  it('balances ordinary TypeScript', () => {
    expect(delimiterBalance('function f() { return [1, (2)]; }')).toEqual({ curly: 0, paren: 0, square: 0 });
  });

  it('ignores delimiters in strings, comments, and template text', () => {
    expect(delimiterBalance('const s = "{"; // ) [\n')).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(delimiterBalance('/* { ( [ */ const x = 1;')).toEqual({ curly: 0, paren: 0, square: 0 });
    expect(delimiterBalance('const t = `a { b ${x} c`;')).toEqual({ curly: 0, paren: 0, square: 0 });
  });
});

describe('delimiterBalance: KNOWN FALSE POSITIVES (why it cannot gate edits)', () => {
  it('JS/TS regex literals — braces inside a regex are counted as code', () => {
    // Real, valid TypeScript. The scanner does not model regex literals, so the
    // `{` inside the pattern is counted. 72 of SideCar's own 900 source files
    // trip this.
    // A character class with an unmatched brace — utterly ordinary in a lexer
    // or a sanitizer, and it makes the scanner miscount.
    const valid = 'const re = /[{]/;\nconst other = 1;';
    expect(delimiterBalance(valid)).not.toEqual({ curly: 0, paren: 0, square: 0 }); // ← WRONG, and known
  });

  it('Rust lifetimes — the apostrophe reads as a string opener', () => {
    // `&'a str` is valid Rust. The `'` opens a "string" that swallows code until
    // the next apostrophe, wrecking everything after it. 58 of 344 real Rust
    // files trip this.
    const valid = "fn f<'a>(s: &'a str) -> &'a str { s }";
    expect(delimiterBalance(valid)).not.toEqual({ curly: 0, paren: 0, square: 0 }); // ← WRONG, and known
  });

  it('Python comments and triple-quotes are not modelled by the code dialect', () => {
    const valid = 'x = 1  # a comment with { and (\ny = 2\n';
    expect(delimiterBalance(valid)).not.toEqual({ curly: 0, paren: 0, square: 0 }); // ← WRONG, and known
  });
});
