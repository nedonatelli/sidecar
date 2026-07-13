import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSyntax, editWouldBreakSyntax } from './syntaxCheck.js';
import * as registry from '../../parsing/registry.js';

// The tree-sitter grammars are not loaded in unit tests (no extension host, no
// wasm dir), so the registry hands back the regex analyzer, which exposes no
// parseTree. That path MUST fail open — an unchecked edit proceeds. The
// error-detecting behaviour is exercised against an injected fake tree, which
// mirrors the web-tree-sitter node shape (type/childCount/child/hasError).

interface FakeNode {
  type: string;
  hasError?: boolean;
  startPosition?: { row: number; column: number };
  childCount: number;
  child(i: number): FakeNode | null;
}

const leaf = (type: string, row = 0): FakeNode => ({
  type,
  hasError: type === 'ERROR',
  startPosition: { row, column: 0 },
  childCount: 0,
  child: () => null,
});

const root = (children: FakeNode[]): FakeNode => ({
  type: 'program',
  hasError: children.some((c) => c.hasError),
  startPosition: { row: 0, column: 0 },
  childCount: children.length,
  child: (i) => children[i] ?? null,
});

/** Fake analyzer whose parseTree reports ERROR nodes for content we mark broken. */
function stubAnalyzer(brokenContents: string[]) {
  return {
    supportedExtensions: new Set(['ts']),
    parseFileContent: () => ({}) as never,
    findRelevantElements: () => [],
    extractRelevantContent: () => '',
    parseTree: (_p: string, content: string) => ({
      rootNode: brokenContents.includes(content)
        ? root([leaf('function'), leaf('ERROR', 2)])
        : root([leaf('function')]),
    }),
  } as never;
}

describe('checkSyntax', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails open for languages with no grammar (never blocks an edit)', async () => {
    const result = await checkSyntax('notes.md', '# not code');
    expect(result.checked).toBe(false);
    expect(result.broken).toBe(false);
  });

  it('fails open when the analyzer has no parse tree (regex fallback)', async () => {
    // This is the real unit-test environment: no wasm, so no tree-sitter.
    const result = await checkSyntax('src/a.ts', 'function ( broken');
    expect(result.broken).toBe(false);
  });

  it('reports parse errors when a tree is available', async () => {
    vi.spyOn(registry, 'getAnalyzer').mockResolvedValue(stubAnalyzer(['BROKEN']));
    const good = await checkSyntax('src/a.ts', 'CLEAN');
    const bad = await checkSyntax('src/a.ts', 'BROKEN');
    expect(good.broken).toBe(false);
    expect(bad.broken).toBe(true);
    expect(bad.errorCount).toBe(1);
    expect(bad.firstErrorLine).toBe(3);
  });
});

describe('editWouldBreakSyntax', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses an edit that makes a parsing file stop parsing (regex-escaped garbage)', async () => {
    // The live v0.119 corruption llama3.2 produced: balanced brackets,
    // token-aligned, and still nonsense — `function welcome\(name: s\)`.
    const before = 'export function greet(name: string): string {\n  return `hi`;\n}\n';
    const after = 'export function greet(name: string): string {\nfunction welcome\\(name: s\\) { return `hi`; }\n}\n';
    vi.spyOn(registry, 'getAnalyzer').mockResolvedValue(stubAnalyzer([after]));

    const verdict = await editWouldBreakSyntax('src/greeter.ts', before, after);
    expect(verdict.refuse).toBe(true);
    expect(verdict.message).toMatch(/would.*make it unparseable|unparseable/i);
    expect(verdict.message).toMatch(/escaped/i);
  });

  it('allows an edit to a file that was ALREADY broken (repairs must not be trapped)', async () => {
    const before = 'function broken\\(x\\) {';
    const after = 'function fixed(x) {}';
    // Both parse-broken in the stub, so the "already broken" branch applies.
    vi.spyOn(registry, 'getAnalyzer').mockResolvedValue(stubAnalyzer([before, after]));

    const verdict = await editWouldBreakSyntax('src/a.ts', before, after);
    expect(verdict.refuse).toBe(false);
  });

  it('allows a clean edit', async () => {
    vi.spyOn(registry, 'getAnalyzer').mockResolvedValue(stubAnalyzer(['NEVER']));
    const verdict = await editWouldBreakSyntax('src/a.ts', 'a', 'b');
    expect(verdict.refuse).toBe(false);
  });
});
