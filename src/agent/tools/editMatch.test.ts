import { describe, it, expect } from 'vitest';
import { findEditMatch, detectEol, applyEol, matchToleranceNote } from './editMatch.js';

/** Splice a match the way resolveEditedText does, so tests assert the real outcome. */
const apply = (text: string, search: string, replace: string): string | null => {
  const m = findEditMatch(text, search, replace);
  if (!m) return null;
  return text.slice(0, m.start) + m.replacement + text.slice(m.end);
};

describe('detectEol', () => {
  it('reports LF, CRLF and CR, and whether the file is uniform', () => {
    expect(detectEol('a\nb\nc')).toEqual({ eol: '\n', uniform: true });
    expect(detectEol('a\r\nb\r\nc')).toEqual({ eol: '\r\n', uniform: true });
    expect(detectEol('a\rb\rc')).toEqual({ eol: '\r', uniform: true });
    // No line breaks at all — LF is the only sane default for anything appended.
    expect(detectEol('single line')).toEqual({ eol: '\n', uniform: true });
  });

  it('picks the dominant ending and flags a mixed file', () => {
    const mixed = 'a\r\nb\r\nc\nd\r\n';
    expect(detectEol(mixed)).toEqual({ eol: '\r\n', uniform: false });
  });
});

describe('applyEol', () => {
  it('rewrites every ending regardless of what it started as', () => {
    expect(applyEol('a\nb', '\r\n')).toBe('a\r\nb');
    expect(applyEol('a\r\nb', '\n')).toBe('a\nb');
    expect(applyEol('a\rb', '\r\n')).toBe('a\r\nb');
    expect(applyEol('a\r\nb', '\r\n')).toBe('a\r\nb');
  });
});

describe('findEditMatch — exact tier', () => {
  it('prefers a byte-exact match and reports its span', () => {
    const text = 'const a = 1;\nconst b = 2;\n';
    const m = findEditMatch(text, 'const b = 2;', 'const b = 3;')!;
    expect(m.tier).toBe('exact');
    expect(text.slice(m.start, m.end)).toBe('const b = 2;');
    expect(m.count).toBe(1);
  });

  it('counts every occurrence so the caller can refuse an ambiguous search', () => {
    const m = findEditMatch('x = 1\nx = 1\n', 'x = 1', 'x = 2')!;
    expect(m.count).toBe(2);
  });

  it('never treats $-sequences in the replacement as regex references', () => {
    // The span is spliced with slice(), so `$&` stays literal.
    expect(apply('cost: TBD\n', 'cost: TBD', "cost: $& $' $1 $$")).toBe("cost: $& $' $1 $$\n");
  });

  it('returns null for an empty search rather than matching everywhere', () => {
    expect(findEditMatch('anything', '', 'x')).toBeNull();
  });
});

describe('findEditMatch — CRLF', () => {
  const crlf = 'function f() {\r\n  return 1;\r\n}\r\n';

  it('matches an LF multi-line search against a CRLF file', () => {
    // The failure this whole tier exists for: the text IS there, byte-exact
    // matching just cannot see it across the \r.
    expect(crlf.includes('  return 1;\n}')).toBe(false);
    const m = findEditMatch(crlf, '  return 1;\n}', '  return 2;\n}')!;
    expect(m.tier).toBe('eol');
    expect(crlf.slice(m.start, m.end)).toBe('  return 1;\r\n}');
  });

  it('writes the replacement with the file’s endings, leaving no mixed endings', () => {
    const out = apply(crlf, '  return 1;\n}', '  return 2;\n  // done\n}')!;
    expect(out).toBe('function f() {\r\n  return 2;\r\n  // done\r\n}\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
  });

  it('adapts the replacement even when the search matched exactly', () => {
    // Single-line searches always matched on CRLF files — but an LF replacement
    // spanning lines still introduced mixed endings.
    const out = apply(crlf, 'return 1;', 'return 1;\n  // note')!;
    expect(out).toBe('function f() {\r\n  return 1;\r\n  // note\r\n}\r\n');
  });

  it('matches a CRLF search against an LF file', () => {
    const lf = 'a = 1\nb = 2\n';
    expect(apply(lf, 'a = 1\r\nb = 2', 'a = 9\r\nb = 8')).toBe('a = 9\nb = 8\n');
  });

  it('handles a lone-CR (classic Mac) file', () => {
    const cr = 'a = 1\rb = 2\r';
    expect(apply(cr, 'a = 1\nb = 2', 'a = 9\nb = 8')).toBe('a = 9\rb = 8\r');
  });

  it('leaves a mixed-ending file’s untouched lines byte-identical', () => {
    // Normalizing the whole file would be a huge unrequested diff; only the
    // replaced span is rewritten.
    const mixed = 'a = 1\r\nb = 2\nc = 3\r\n';
    const out = apply(mixed, 'b = 2', 'b = 9')!;
    expect(out).toBe('a = 1\r\nb = 9\nc = 3\r\n');
  });
});

describe('findEditMatch — trailing whitespace', () => {
  it('matches text copied from a right-trimmed read', () => {
    // read_file(mode='compact') trims line ends, so its output cannot match the
    // file byte-for-byte.
    const text = 'const a = 1;   \nconst b = 2;\n';
    const m = findEditMatch(text, 'const a = 1;\nconst b = 2;', 'const a = 5;\nconst b = 2;')!;
    expect(m.tier).toBe('trailing-space');
    expect(apply(text, 'const a = 1;\nconst b = 2;', 'const a = 5;\nconst b = 2;')).toBe(
      'const a = 5;\nconst b = 2;\n',
    );
  });

  it('does not fire when the exact tier already matched', () => {
    const text = 'value   \n';
    expect(findEditMatch(text, 'value   ', 'other')!.tier).toBe('exact');
  });
});

describe('findEditMatch — indentation', () => {
  const text = 'class C:\n    def f(self):\n        return 1\n';

  it('matches a block the model retyped without its indentation', () => {
    const m = findEditMatch(text, 'def f(self):\n    return 1', 'def f(self):\n    return 2')!;
    expect(m.tier).toBe('indent');
    // The span starts at the line's real indentation, not mid-line.
    expect(text.slice(m.start, m.end)).toBe('    def f(self):\n        return 1');
  });

  it('re-indents the replacement onto the file’s indentation, preserving nesting', () => {
    const out = apply(text, 'def f(self):\n    return 1', 'def f(self):\n    x = 1\n    return x')!;
    expect(out).toBe('class C:\n    def f(self):\n        x = 1\n        return x\n');
  });

  it('shifts left when the model over-indents, preserving relative nesting', () => {
    // The rule is a SHIFT, not a re-tabulation: the anchor line is re-based onto
    // the file's indentation and every other line moves by the same delta. The
    // replacement's internal nesting (here 4 spaces deeper than its anchor) is
    // preserved as-is. Converting indent WIDTH — 4-space nesting into the file's
    // 2-space — would mean inferring the file's indent unit and rewriting every
    // level, which is far more invasive and gets Python wrong in more ways than
    // it fixes. Python allows per-block widths, so the shifted result is valid.
    const flat = 'def f():\n  return 1\n';
    const out = apply(flat, '    def f():\n        return 1', '    def f():\n        return 2')!;
    expect(out).toBe('def f():\n    return 2\n');
  });

  it('does not add indentation to blank lines', () => {
    const out = apply(text, 'def f(self):\n    return 1', 'def f(self):\n\n    return 2')!;
    expect(out).toBe('class C:\n    def f(self):\n\n        return 2\n');
    expect(out).not.toMatch(/^[ \t]+$/m);
  });

  it('combines with CRLF', () => {
    const crlfPy = 'class C:\r\n    def f(self):\r\n        return 1\r\n';
    const out = apply(crlfPy, 'def f(self):\n    return 1', 'def f(self):\n    return 2')!;
    expect(out).toBe('class C:\r\n    def f(self):\r\n        return 2\r\n');
  });
});

describe('findEditMatch — tier precedence', () => {
  it('an exact match wins even where a laxer tier would find siblings', () => {
    // `  a = 1` appears once byte-exact and twice ignoring indentation. The
    // search is unambiguous as written, so it must not be called ambiguous.
    const text = 'a = 1\n  a = 1\n';
    const m = findEditMatch(text, '  a = 1', '  a = 2')!;
    expect(m.tier).toBe('exact');
    expect(m.count).toBe(1);
  });

  it('reports the count from the tier that actually matched', () => {
    const text = 'x = 1\r\ny = 2\r\nx = 1\r\ny = 2\r\n';
    const m = findEditMatch(text, 'x = 1\ny = 2', 'x = 9\ny = 8')!;
    expect(m.tier).toBe('eol');
    expect(m.count).toBe(2);
  });

  it('returns null when no tier can find the text', () => {
    expect(findEditMatch('a = 1\n', 'completely different', 'x')).toBeNull();
  });
});

describe('matchToleranceNote', () => {
  it('says nothing for an exact match', () => {
    const text = 'a = 1\n';
    expect(matchToleranceNote(findEditMatch(text, 'a = 1', 'a = 2')!, 'f.ts', text)).toBe('');
  });

  it('names the line-ending mismatch so the model can fix its next search', () => {
    const text = 'a = 1\r\nb = 2\r\n';
    const note = matchToleranceNote(findEditMatch(text, 'a = 1\nb = 2', 'a = 9\nb = 8')!, 'f.ts', text);
    expect(note).toContain('CRLF');
    expect(note).toContain('f.ts');
  });

  it('warns that a re-indented edit needs verifying', () => {
    const text = 'class C:\n    def f(self):\n        return 1\n';
    const note = matchToleranceNote(
      findEditMatch(text, 'def f(self):\n    return 1', 'def f(self):\n    return 2')!,
      'f.py',
      text,
    );
    expect(note).toContain('indentation');
    expect(note).toContain('Verify');
  });
});
