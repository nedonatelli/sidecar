import { describe, it, expect, afterEach } from 'vitest';
import {
  checkSyntax,
  editWouldBreakSyntax,
  tryLiteralEscapeRecovery,
  __setParserForTests,
  __resetParserCache,
} from './syntaxCheck.js';

// Unit tests have no extension host, so no grammars path — the real parser is
// unavailable and every check must FAIL OPEN. The error-detecting behaviour is
// exercised through the parser seam, whose fake mirrors the web-tree-sitter
// node shape (type / childCount / child / hasError / startPosition).

interface FakeNode {
  type: string;
  hasError: boolean;
  startPosition: { row: number; column: number };
  childCount: number;
  child(i: number): FakeNode | null;
}

const node = (type: string, row = 0, children: FakeNode[] = []): FakeNode => ({
  type,
  hasError: type === 'ERROR' || children.some((c) => c.hasError),
  startPosition: { row, column: 0 },
  childCount: children.length,
  child: (i) => children[i] ?? null,
});

/** Parser that reports one ERROR node (at row 2) for any content listed as broken. */
const fakeParser = (brokenContents: string[]) => ({
  parse: (content: string) => ({
    rootNode: brokenContents.includes(content)
      ? node('program', 0, [node('function_declaration'), node('ERROR', 2)])
      : node('program', 0, [node('function_declaration')]),
  }),
});

afterEach(() => __resetParserCache());

describe('checkSyntax', () => {
  it('fails open for a language with no grammar', async () => {
    const result = await checkSyntax('notes.md', '# not code');
    expect(result.checked).toBe(false);
    expect(result.broken).toBe(false);
  });

  it('uses the REAL grammars outside the extension host (eval harness, sandboxes)', async () => {
    // Before the wasm-dir fallback, the guard was inert anywhere setGrammarsPath
    // had not run — the eval harness let a model write `@tsDocParam(` to a .ts
    // file and reported success. A guard that only works in the extension host
    // cannot be regression-tested, which is how the write_file bypass survived.
    const broken = await checkSyntax('src/a.ts', 'function ( hopelessly broken');
    expect(broken.checked).toBe(true);
    expect(broken.broken).toBe(true);

    const clean = await checkSyntax('src/a.ts', 'export const x = 1;\n');
    expect(clean.checked).toBe(true);
    expect(clean.broken).toBe(false);
  });

  it('reports parse errors when a parser is available', async () => {
    __setParserForTests('typescript', fakeParser(['BROKEN']));
    const good = await checkSyntax('src/a.ts', 'CLEAN');
    const bad = await checkSyntax('src/a.ts', 'BROKEN');
    expect(good.checked).toBe(true);
    expect(good.broken).toBe(false);
    expect(bad.broken).toBe(true);
    expect(bad.errorCount).toBe(1);
    expect(bad.firstErrorLine).toBe(3); // row 2 → 1-based line 3
  });
});

describe('editWouldBreakSyntax', () => {
  it('refuses an edit that makes a parsing file stop parsing (live regex-escaped corruption)', async () => {
    // What llama3.2 actually wrote: bracket-balanced, token-aligned, garbage.
    const before = 'export function greet(name: string): string {\n  return `hi`;\n}\n';
    const after = 'export function greet(name: string): string {\nfunction welcome\\(name: s\\) { return `hi`; }\n}\n';
    __setParserForTests('typescript', fakeParser([after]));

    const verdict = await editWouldBreakSyntax('src/greeter.ts', before, after);
    expect(verdict.refuse).toBe(true);
    expect(verdict.message).toMatch(/new syntax error/i);
    expect(verdict.message).toMatch(/escaped/i);
  });

  it('allows an edit to a file that is ALREADY broken — repairs must not be trapped', async () => {
    const before = 'function broken\\(x\\) {';
    const after = 'function stillBad(';
    __setParserForTests('typescript', fakeParser([before, after]));

    const verdict = await editWouldBreakSyntax('src/a.ts', before, after);
    expect(verdict.refuse).toBe(false);
  });

  it('allows a clean edit', async () => {
    __setParserForTests('typescript', fakeParser(['NOTHING_MATCHES']));
    const verdict = await editWouldBreakSyntax('src/a.ts', 'a', 'b');
    expect(verdict.refuse).toBe(false);
  });

  it('refuses real broken source with the real grammars (no stub)', async () => {
    const verdict = await editWouldBreakSyntax(
      'src/a.ts',
      'export const x = 1;\n',
      '@tsDocParam(', // exactly what llama3.2 wrote to a .ts file via write_file
    );
    expect(verdict.refuse).toBe(true);
    expect(verdict.message).toMatch(/new syntax error/i);
  });

  it('fails open for a language with no grammar', async () => {
    const verdict = await editWouldBreakSyntax('notes.md', '# hi', '### ( not code');
    expect(verdict.refuse).toBe(false);
  });
});

// #109: error counts stopped at 20, so a file with 20+ errors compared 20
// before vs 20 after and every edit passed as "not worse".
describe('editWouldBreakSyntax — files with many existing errors', () => {
  const broken = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = (;\n`).join('');

  it('still refuses an edit that adds errors to a file that has 25', async () => {
    const result = await editWouldBreakSyntax('a.ts', broken(25), broken(30));
    expect(result.refuse).toBe(true);
  });

  it('reports two capped counts as unchecked, not "not worse"', async () => {
    const result = await editWouldBreakSyntax('a.ts', broken(1100), broken(1200));
    expect(result).toEqual({ refuse: false, verdict: 'unchecked' });
  });
});

describe('tryLiteralEscapeRecovery (code-as-text escape contamination)', () => {
  it('decodes the llama3.2 calculator shape — literal \\n between statements — when the decode parses', async () => {
    // Verbatim failure shape from the steer A/B (r1-on): content arrived as an
    // escaped string; every write was refused; the run died with the model's
    // code complete but undeliverable.
    const contaminated =
      'import math\\n\\ndef add(a, b):\\n    return a + b\\n\\ndef subtract(a, b):\\n    return a - b\\n';
    const recovered = await tryLiteralEscapeRecovery('calculator.py', '', contaminated);
    expect(recovered).not.toBeNull();
    expect(recovered).toContain('import math\n\ndef add(a, b):\n    return a + b');
    expect(recovered).not.toContain('\\n');
  });

  it('returns null when the decode UNDOES the edit — the sphinx-8474 false success', async () => {
    // Live 2026-09-15: the edit's purpose was to put a literal \n into source
    // (sphinx-doc__sphinx-8474 is about newline escaping, so the code under
    // repair is exactly the code this recovery misreads). Decoding turned the
    // new text back into the original file, which of course parsed — so the
    // caller wrote it and reported "File edited" over a change that never
    // happened. The model re-sent the identical edit SIX times, each one
    // reporting success, and the run burned to the 50-turn cap.
    const before = "lines = nl_escape_re.sub('', text).split('\n')\n";
    // The model asks for the two-character escape; decoding reproduces `before`.
    const after = "lines = nl_escape_re.sub('', text).split('\\n')\n";
    expect(await tryLiteralEscapeRecovery('std.py', before, after)).toBeNull();
  });

  it('still decodes when the result differs from the original file', async () => {
    // The guard must not disarm the recovery it sits inside: a genuine
    // escape-contaminated write still decodes.
    const before = 'x = 1\n';
    const after = 'x = 1\\ndef f():\\n    return 2\n';
    const recovered = await tryLiteralEscapeRecovery('a.py', before, after);
    expect(recovered).not.toBeNull();
    expect(recovered).not.toBe(before);
  });

  // #109: decoding the whole file rewrote escapes that were already in it.
  it('leaves escapes outside the edited text alone', async () => {
    // File bytes: sep = "\\n".join(parts) -- an escaped backslash then n.
    // Decoded, that is a backslash-newline line continuation, which still parses.
    const before = 'sep = "\\\\n".join(parts)\n';
    const after = before + 'def f():\\n    return 1\n';
    const recovered = await tryLiteralEscapeRecovery('a.py', before, after);
    expect(recovered).toBe(before + 'def f():\n    return 1\n');
  });

  it('returns null when the content has no literal escapes', async () => {
    expect(await tryLiteralEscapeRecovery('a.py', '', 'def broken(:\n    pass\n')).toBeNull();
  });

  it('returns null when decoding does not fix the parse', async () => {
    // Broken def stays broken after decode; an in-string \n that decodes to a
    // real newline inside quotes only adds to the damage. No rescue.
    const contaminated = "def f(:\\n    x = 'a\\nb'\\n";
    expect(await tryLiteralEscapeRecovery('a.py', '', contaminated)).toBeNull();
  });

  it('returns null for a grammarless file — no positive parse, no rescue', async () => {
    expect(await tryLiteralEscapeRecovery('notes.md', '', 'line one\\nline two')).toBeNull();
  });
});
