import { describe, it, expect, afterEach } from 'vitest';
import { checkSyntax, editWouldBreakSyntax, __setParserForTests, __resetParserCache } from './syntaxCheck.js';

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

  it('fails open when no parser is available (no grammars path — the unit-test env)', async () => {
    const result = await checkSyntax('src/a.ts', 'function ( hopelessly broken');
    expect(result.checked).toBe(false);
    expect(result.broken).toBe(false);
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
    expect(verdict.message).toMatch(/unparseable/i);
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

  it('fails open (allows the edit) when no parser is available', async () => {
    const verdict = await editWouldBreakSyntax('src/a.ts', 'clean', 'total ( garbage');
    expect(verdict.refuse).toBe(false);
  });
});
