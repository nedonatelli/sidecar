import { describe, it, expect, vi, afterEach } from 'vitest';
import { projectKnowledgeSearch } from './projectKnowledge.js';
import { getDefaultToolRuntime, setSymbolEmbeddings } from './runtime.js';
import type { SymbolEmbeddingIndex, SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';

/**
 * Tests exercise the tool's response shape + its handling of the
 * runtime wiring / readiness states. We never construct a real
 * `SymbolEmbeddingIndex` here — a fake with the two methods the tool
 * actually calls (`isReady`, `search`) is enough to cover every branch.
 */

function makeFakeIndex(
  overrides: Partial<{ isReady: boolean; results: SymbolSearchResult[] }> = {},
): SymbolEmbeddingIndex {
  return {
    isReady: () => overrides.isReady ?? true,
    search: vi.fn(async () => overrides.results ?? []),
  } as never;
}

describe('project_knowledge_search tool', () => {
  afterEach(() => {
    // Detach any index wired during a test so runs don't bleed.
    setSymbolEmbeddings(null);
  });

  it('returns a helpful message when the index is not wired', async () => {
    setSymbolEmbeddings(null);
    const result = await projectKnowledgeSearch({ query: 'anything' });
    expect(result).toContain('not enabled');
    expect(result).toContain('sidecar.projectKnowledge.enabled');
  });

  it('returns a warming-up message when the index exists but isReady is false', async () => {
    setSymbolEmbeddings(makeFakeIndex({ isReady: false }));
    const result = await projectKnowledgeSearch({ query: 'anything' });
    expect(result).toContain('warming up');
  });

  it('returns an error when query is missing or empty', async () => {
    setSymbolEmbeddings(makeFakeIndex());
    const result1 = await projectKnowledgeSearch({ query: '' });
    const result2 = await projectKnowledgeSearch({});
    expect(result1).toContain('query is required');
    expect(result2).toContain('query is required');
  });

  it('reports no matches when search returns empty', async () => {
    setSymbolEmbeddings(makeFakeIndex({ results: [] }));
    const result = await projectKnowledgeSearch({ query: 'xyz' });
    expect(result).toContain('No symbol-level matches for "xyz"');
  });

  it('formats hits as filePath:range\\tkind\\tqualifiedName\\t(vector: N.NNN)', async () => {
    const results: SymbolSearchResult[] = [
      {
        symbolId: 'src/auth.ts::requireAuth',
        filePath: 'src/auth.ts',
        qualifiedName: 'requireAuth',
        name: 'requireAuth',
        kind: 'function',
        startLine: 10,
        endLine: 25,
        similarity: 0.8234,
      },
      {
        symbolId: 'src/util.ts::parseToken',
        filePath: 'src/util.ts',
        qualifiedName: 'parseToken',
        name: 'parseToken',
        kind: 'function',
        startLine: 42,
        endLine: 42, // single-line — should render as just "42"
        similarity: 0.611,
      },
    ];
    setSymbolEmbeddings(makeFakeIndex({ results }));

    const response = await projectKnowledgeSearch({ query: 'auth validation' });

    expect(response).toContain('Found 2 symbols for "auth validation"');
    expect(response).toContain('src/auth.ts:10-25\tfunction\trequireAuth\t(vector: 0.823)');
    expect(response).toContain('src/util.ts:42\tfunction\tparseToken\t(vector: 0.611)');
  });

  it('forwards kindFilter + pathPrefix to the index', async () => {
    const fakeIndex = makeFakeIndex();
    setSymbolEmbeddings(fakeIndex);
    await projectKnowledgeSearch({
      query: 'auth',
      kindFilter: ['function', 'method'],
      pathPrefix: 'src/middleware/',
    });
    const searchCall = (fakeIndex.search as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(searchCall[2]).toEqual({ kindFilter: ['function', 'method'], pathPrefix: 'src/middleware/' });
  });

  it('clamps maxHits to 50 and defaults to 10 when omitted', async () => {
    const fakeIndex = makeFakeIndex();
    setSymbolEmbeddings(fakeIndex);

    await projectKnowledgeSearch({ query: 'x' });
    expect((fakeIndex.search as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(10);

    await projectKnowledgeSearch({ query: 'x', maxHits: 200 });
    expect((fakeIndex.search as ReturnType<typeof vi.fn>).mock.calls[1][1]).toBe(50);

    await projectKnowledgeSearch({ query: 'x', maxHits: 5 });
    expect((fakeIndex.search as ReturnType<typeof vi.fn>).mock.calls[2][1]).toBe(5);
  });

  it('drops empty-array kindFilter rather than passing []', async () => {
    // A caller that serializes {} → [] for the filter shouldn't
    // inadvertently restrict results to zero kinds.
    const fakeIndex = makeFakeIndex();
    setSymbolEmbeddings(fakeIndex);
    await projectKnowledgeSearch({ query: 'x', kindFilter: [] });
    expect((fakeIndex.search as ReturnType<typeof vi.fn>).mock.calls[0][2]).toEqual({
      kindFilter: undefined,
      pathPrefix: undefined,
    });
  });
});

describe('setSymbolEmbeddings runtime wiring', () => {
  it('attaches and detaches cleanly on the default runtime', () => {
    const fakeIndex = makeFakeIndex();
    setSymbolEmbeddings(fakeIndex);
    expect(getDefaultToolRuntime().symbolEmbeddings).toBe(fakeIndex);
    setSymbolEmbeddings(null);
    expect(getDefaultToolRuntime().symbolEmbeddings).toBeNull();
  });
});
