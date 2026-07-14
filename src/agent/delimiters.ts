// Balanced-delimiter scanning — the classic "valid parentheses" problem, but
// on real text, where the hard part is knowing which delimiters COUNT.
//
// Two call sites depend on getting this right, and both were bitten by naive
// versions in the v0.119 dogfood pass:
//
//   1. textParsing's bare-JSON scanner. A naive depth count ran off on the
//      commonest call there is — a code edit — because the argument VALUES
//      carry braces:
//        {"name":"edit_file","arguments":{"search":"… : string {", …}}
//      The `{` inside the search STRING pushed the depth up, the object never
//      closed, the arguments were discarded, and the call dispatched as
//      edit_file({}). qwen2.5-coder then apologized and abandoned a rename it
//      had gotten right on its first attempt.
//
//   2. fs.ts's structural guard (`isStructurallySafeReplacement`), which
//      refuses an inferred edit whose bracket balance differs from the region
//      it replaces. Counting braces inside string literals and comments makes
//      it refuse legitimate edits — `const s = "{";` reads as +1 curly — and,
//      worse, lets a genuinely unbalanced edit look balanced when the noise
//      cancels out.
//
// So: skip over string literals (and, for code, comments) before counting.
// Not a full lexer — just enough to make the delimiters that matter countable.

/** Delimiter counts: opens minus closes, per bracket family. */
export interface DelimiterBalance {
  curly: number;
  paren: number;
  square: number;
}

export interface ScanOptions {
  /**
   * 'json'  — only double-quoted strings, backslash escapes. For model output.
   * 'code'  — single/double/backtick strings, `//` and `/* *​/` comments.
   *           Template-literal `${…}` interpolations still count (they are real
   *           braces in the source), which is correct: they must balance.
   */
  dialect: 'json' | 'code';
}

/**
 * Index of the `}` that closes the object opening at `start`, or -1 when the
 * text ends first (a truncated emission — the caller decides what to salvage).
 * `text[start]` must be `{`.
 */
export function findBalancedEnd(text: string, start: number, opts: ScanOptions = { dialect: 'json' }): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const skipped = skipNonCode(text, i, opts.dialect);
    if (skipped > i) {
      i = skipped - 1; // -1 because the loop will ++
      continue;
    }
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Net delimiter balance of a snippet. Strings and (in `code`) comments are
 * skipped, so braces that are merely *inside* a literal don't count.
 */
export function delimiterBalance(s: string, opts: ScanOptions = { dialect: 'code' }): DelimiterBalance {
  const out: DelimiterBalance = { curly: 0, paren: 0, square: 0 };
  for (let i = 0; i < s.length; i++) {
    const skipped = skipNonCode(s, i, opts.dialect);
    if (skipped > i) {
      i = skipped - 1;
      continue;
    }
    switch (s[i]) {
      case '{':
        out.curly++;
        break;
      case '}':
        out.curly--;
        break;
      case '(':
        out.paren++;
        break;
      case ')':
        out.paren--;
        break;
      case '[':
        out.square++;
        break;
      case ']':
        out.square--;
        break;
    }
  }
  return out;
}

/** True when two snippets open and close exactly the same delimiters. */
export function balanceEquals(a: DelimiterBalance, b: DelimiterBalance): boolean {
  return a.curly === b.curly && a.paren === b.paren && a.square === b.square;
}

/**
 * If `i` starts a string or comment, return the index just past it; otherwise
 * return `i`. Unterminated literals consume to end-of-input — a truncated
 * string cannot contain a delimiter that closes anything.
 *
 * Template literals are scanned but their `${…}` interpolations are NOT
 * skipped: those braces are real code and must balance. The interpolation's
 * own nested strings are handled by recursion through the main loop, which is
 * why this returns the index just past the literal's opening segment rather
 * than the whole literal.
 */
function skipNonCode(s: string, i: number, dialect: 'json' | 'code'): number {
  const ch = s[i];

  if (ch === '"' || (dialect === 'code' && ch === "'")) {
    return skipQuoted(s, i, ch);
  }

  if (dialect === 'code') {
    if (ch === '`') return skipTemplate(s, i);
    if (ch === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      return nl === -1 ? s.length : nl;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const close = s.indexOf('*/', i + 2);
      return close === -1 ? s.length : close + 2;
    }
  }

  return i;
}

/** Index just past a quoted string starting at `i` (backslash escapes honored). */
function skipQuoted(s: string, i: number, quote: string): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') {
      j++; // skip the escaped char
      continue;
    }
    if (s[j] === quote) return j + 1;
  }
  return s.length; // unterminated
}

/**
 * Index just past a template literal, INCLUDING its `${…}` interpolations.
 *
 * The interpolations' braces always balance within the literal (an unbalanced
 * one is a syntax error, which the parse guard catches separately), so a
 * well-formed template contributes zero net delimiters and can be skipped
 * wholesale. Tracking the interpolation depth is still necessary: a backtick
 * INSIDE an interpolation (`${a ? `x` : `y`}`) must not be mistaken for the
 * literal's end.
 *
 * An earlier version stopped at the START of each interpolation and let the
 * main loop resume — which re-entered template mode on the CLOSING backtick and
 * swallowed the code after it, silently eating a real `}`.
 */
function skipTemplate(s: string, i: number): number {
  let depth = 0; // `${` nesting
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '$' && s[j + 1] === '{') {
      depth++;
      j++;
      continue;
    }
    if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      continue;
    }
    if (c === '`') return j + 1;
  }
  return s.length; // unterminated
}
