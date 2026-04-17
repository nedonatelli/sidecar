import { describe, it, expect, vi, afterEach } from 'vitest';
import { projectKnowledgeSearch, enrichWithGraphWalk } from './projectKnowledge.js';
import { getDefaultToolRuntime, setSymbolEmbeddings, setSymbolGraph } from './runtime.js';
import type { SymbolEmbeddingIndex, SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';
import { SymbolGraph, type SymbolEntry, type CallEdge } from '../../config/symbolGraph.js';

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
    // Detach any index/graph wired during a test so runs don't bleed.
    setSymbolEmbeddings(null);
    setSymbolGraph(null);
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

  it('enriches results with graph-walked callers when a symbol graph is wired', async () => {
    // Hand-built graph: requireAuth is defined in middleware/auth.ts
    // and called from routes/users.ts:handleUsers. Vector search only
    // returns requireAuth; graph walk should discover handleUsers.
    const graph = new SymbolGraph();
    const authSym: SymbolEntry = {
      name: 'requireAuth',
      qualifiedName: 'requireAuth',
      type: 'function',
      filePath: 'src/middleware/auth.ts',
      startLine: 10,
      endLine: 25,
      exported: true,
    };
    const handlerSym: SymbolEntry = {
      name: 'handleUsers',
      qualifiedName: 'handleUsers',
      type: 'function',
      filePath: 'src/routes/users.ts',
      startLine: 5,
      endLine: 20,
      exported: true,
    };
    const callEdge: CallEdge = {
      callerFile: 'src/routes/users.ts',
      callerName: 'handleUsers',
      calleeName: 'requireAuth',
      line: 12,
    };
    graph.addFile('src/middleware/auth.ts', [authSym], [], 'h1');
    graph.addFile('src/routes/users.ts', [handlerSym], [], 'h2', [callEdge]);
    setSymbolGraph(graph);

    setSymbolEmbeddings(
      makeFakeIndex({
        results: [
          {
            symbolId: 'src/middleware/auth.ts::requireAuth',
            filePath: 'src/middleware/auth.ts',
            qualifiedName: 'requireAuth',
            name: 'requireAuth',
            kind: 'function',
            startLine: 10,
            endLine: 25,
            similarity: 0.9,
          },
        ],
      }),
    );

    const response = await projectKnowledgeSearch({ query: 'auth', graphWalkDepth: 1 });

    expect(response).toContain('Found 1 direct + 1 graph-reached');
    expect(response).toContain('vector: 0.900');
    expect(response).toContain('src/routes/users.ts:5-20\tfunction\thandleUsers');
    expect(response).toContain('graph: called-by (1 hop from requireAuth)');
  });

  it('skips graph walk when graphWalkDepth is 0', async () => {
    const graph = new SymbolGraph();
    // Same fixture; depth 0 means we should NEVER see the caller.
    graph.addFile(
      'src/auth.ts',
      [
        {
          name: 'requireAuth',
          qualifiedName: 'requireAuth',
          type: 'function',
          filePath: 'src/auth.ts',
          startLine: 1,
          endLine: 5,
          exported: true,
        },
      ],
      [],
      'h',
    );
    graph.addFile(
      'src/routes.ts',
      [
        {
          name: 'handler',
          qualifiedName: 'handler',
          type: 'function',
          filePath: 'src/routes.ts',
          startLine: 1,
          endLine: 5,
          exported: true,
        },
      ],
      [],
      'h',
      [{ callerFile: 'src/routes.ts', callerName: 'handler', calleeName: 'requireAuth', line: 3 }],
    );
    setSymbolGraph(graph);
    setSymbolEmbeddings(
      makeFakeIndex({
        results: [
          {
            symbolId: 'src/auth.ts::requireAuth',
            filePath: 'src/auth.ts',
            qualifiedName: 'requireAuth',
            name: 'requireAuth',
            kind: 'function',
            startLine: 1,
            endLine: 5,
            similarity: 0.8,
          },
        ],
      }),
    );

    const response = await projectKnowledgeSearch({ query: 'x', graphWalkDepth: 0 });

    expect(response).not.toContain('graph-reached');
    expect(response).not.toContain('called-by');
    expect(response).toContain('Found 1 symbol');
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

describe('enrichWithGraphWalk (v0.61 b.4)', () => {
  // Canonical graph used across most tests: a middleware + two
  // route handlers, all calling `requireAuth`. BFS should surface
  // both handlers from a single direct hit on `requireAuth`.
  function buildFixture() {
    const graph = new SymbolGraph();
    const authSym: SymbolEntry = {
      name: 'requireAuth',
      qualifiedName: 'requireAuth',
      type: 'function',
      filePath: 'src/middleware/auth.ts',
      startLine: 10,
      endLine: 25,
      exported: true,
    };
    const usersHandler: SymbolEntry = {
      name: 'handleUsers',
      qualifiedName: 'handleUsers',
      type: 'function',
      filePath: 'src/routes/users.ts',
      startLine: 1,
      endLine: 15,
      exported: true,
    };
    const postsHandler: SymbolEntry = {
      name: 'handlePosts',
      qualifiedName: 'handlePosts',
      type: 'function',
      filePath: 'src/routes/posts.ts',
      startLine: 1,
      endLine: 15,
      exported: true,
    };
    graph.addFile('src/middleware/auth.ts', [authSym], [], 'h1');
    graph.addFile('src/routes/users.ts', [usersHandler], [], 'h2', [
      { callerFile: 'src/routes/users.ts', callerName: 'handleUsers', calleeName: 'requireAuth', line: 5 },
    ]);
    graph.addFile('src/routes/posts.ts', [postsHandler], [], 'h3', [
      { callerFile: 'src/routes/posts.ts', callerName: 'handlePosts', calleeName: 'requireAuth', line: 7 },
    ]);
    return graph;
  }

  const authDirectHit: SymbolSearchResult = {
    symbolId: 'src/middleware/auth.ts::requireAuth',
    filePath: 'src/middleware/auth.ts',
    qualifiedName: 'requireAuth',
    name: 'requireAuth',
    kind: 'function',
    startLine: 10,
    endLine: 25,
    similarity: 0.9,
  };

  it('returns direct hits unchanged when graph is null', () => {
    const enriched = enrichWithGraphWalk([authDirectHit], null, { maxDepth: 2, maxGraphHits: 10 });
    expect(enriched).toHaveLength(1);
    expect(enriched[0].relationship).toBe('vector: 0.900');
  });

  it('returns direct hits unchanged when maxDepth is 0', () => {
    const graph = buildFixture();
    const enriched = enrichWithGraphWalk([authDirectHit], graph, { maxDepth: 0, maxGraphHits: 10 });
    expect(enriched).toHaveLength(1);
  });

  it('surfaces callers at the containing-symbol level', () => {
    const graph = buildFixture();
    const enriched = enrichWithGraphWalk([authDirectHit], graph, { maxDepth: 1, maxGraphHits: 10 });
    expect(enriched).toHaveLength(3); // auth + 2 handlers
    const names = enriched.map((e) => e.name).sort();
    expect(names).toEqual(['handlePosts', 'handleUsers', 'requireAuth']);
    // Direct vector hit outranks the decayed graph hops.
    expect(enriched[0].name).toBe('requireAuth');
    // Both handlers tagged as graph: called-by with 1 hop.
    const users = enriched.find((e) => e.name === 'handleUsers');
    expect(users?.relationship).toBe('graph: called-by (1 hop from requireAuth)');
  });

  it('decays scores with hop distance so nearer hits rank higher', () => {
    const graph = buildFixture();
    const enriched = enrichWithGraphWalk([authDirectHit], graph, { maxDepth: 1, maxGraphHits: 10 });
    const handler = enriched.find((e) => e.name === 'handleUsers')!;
    // Score should be the direct similarity decayed by 0.5^1.
    expect(handler.score).toBeCloseTo(0.9 * 0.5, 5);
    expect(handler.score).toBeLessThan(enriched[0].score);
  });

  it('caps added symbols at maxGraphHits', () => {
    const graph = buildFixture();
    const enriched = enrichWithGraphWalk([authDirectHit], graph, { maxDepth: 1, maxGraphHits: 1 });
    // Direct + 1 graph-reached = 2 total.
    expect(enriched).toHaveLength(2);
  });

  it('does not revisit symbols reached via earlier frontier starts', () => {
    // Two vector hits that share a caller. Graph walk should
    // dedupe — each caller appears once in the enriched list.
    const graph = buildFixture();
    const secondHit: SymbolSearchResult = {
      ...authDirectHit,
      symbolId: 'other',
      qualifiedName: 'requireAuth', // same name → same callers
      similarity: 0.7,
    };
    const enriched = enrichWithGraphWalk([authDirectHit, secondHit], graph, {
      maxDepth: 1,
      maxGraphHits: 10,
    });
    const handlerCount = enriched.filter((e) => e.name === 'handleUsers').length;
    expect(handlerCount).toBe(1);
  });
});
