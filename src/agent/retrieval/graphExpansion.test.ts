import { describe, it, expect } from 'vitest';
import { enrichWithGraphWalk, adaptiveGraphDepth } from './graphExpansion.js';
import type { SymbolGraph } from '../../config/symbolGraph.js';
import type { SymbolSearchResult } from '../../config/symbolEmbeddingIndex.js';

// ---------------------------------------------------------------------------
// Tests for graphExpansion.ts (v0.65 chunk 5.5).
//
// adaptiveGraphDepth → bucket math for model context size.
//
// enrichWithGraphWalk → existing behavior was previously tested via
// projectKnowledge.ts; these tests pin the extracted module directly.
// We exercise:
//   - no-op paths (null graph, depth=0, empty direct hits)
//   - direct hits pass through with vector provenance
//   - caller walk surfaces symbols the query alone wouldn't reach
//   - depth caps work (depth=1 doesn't surface 2-hop callers)
//   - maxGraphHits budget cap
//   - score decay: 0.5^hops
//   - stable ordering: higher-score wins
//   - dedup across overlapping BFS starts
// ---------------------------------------------------------------------------

function mockGraph(spec: {
  callers?: Record<string, Array<{ callerFile: string; line: number }>>;
  symbolsInFile?: Record<
    string,
    Array<{ qualifiedName: string; name: string; type: string; startLine: number; endLine: number }>
  >;
}): SymbolGraph {
  return {
    getCallers: (name: string) => spec.callers?.[name] ?? [],
    getSymbolsInFile: (file: string) => spec.symbolsInFile?.[file] ?? [],
  } as unknown as SymbolGraph;
}

function directHit(overrides: Partial<SymbolSearchResult> = {}): SymbolSearchResult {
  return {
    filePath: 'src/auth.ts',
    qualifiedName: 'requireAuth',
    name: 'requireAuth',
    kind: 'function',
    startLine: 10,
    endLine: 30,
    similarity: 0.9,
    ...overrides,
  } as SymbolSearchResult;
}

describe('adaptiveGraphDepth', () => {
  it('returns 0 for < 8K contexts (small local models)', () => {
    expect(adaptiveGraphDepth(4096)).toBe(0);
    expect(adaptiveGraphDepth(8191)).toBe(0);
  });

  it('returns 1 for 8K–64K contexts (local + modest paid)', () => {
    expect(adaptiveGraphDepth(8192)).toBe(1);
    expect(adaptiveGraphDepth(16384)).toBe(1);
    expect(adaptiveGraphDepth(65535)).toBe(1);
  });

  it('returns 2 for >= 64K contexts (large paid backends)', () => {
    expect(adaptiveGraphDepth(65536)).toBe(2);
    expect(adaptiveGraphDepth(200_000)).toBe(2);
    expect(adaptiveGraphDepth(1_000_000)).toBe(2);
  });

  it('defaults to 1 when contextLength is null or undefined (middle ground)', () => {
    expect(adaptiveGraphDepth(null)).toBe(1);
    expect(adaptiveGraphDepth(undefined)).toBe(1);
  });

  it('clamps zero or negative to 0 (likely a misconfigured probe)', () => {
    expect(adaptiveGraphDepth(0)).toBe(0);
    expect(adaptiveGraphDepth(-1)).toBe(0);
  });
});

describe('enrichWithGraphWalk — no-op paths', () => {
  it('returns empty array for empty direct hits', () => {
    const out = enrichWithGraphWalk([], mockGraph({}), { maxDepth: 2, maxGraphHits: 10 });
    expect(out).toEqual([]);
  });

  it('returns only direct hits (vector provenance) when graph is null', () => {
    const out = enrichWithGraphWalk([directHit()], null, { maxDepth: 2, maxGraphHits: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].relationship).toMatch(/^vector:/);
  });

  it('returns only direct hits when maxDepth=0 (walk disabled)', () => {
    const graph = mockGraph({
      callers: { requireAuth: [{ callerFile: 'src/route.ts', line: 15 }] },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 0, maxGraphHits: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('requireAuth');
  });

  it('returns only direct hits when maxGraphHits=0 (budget exhausted)', () => {
    const graph = mockGraph({
      callers: { requireAuth: [{ callerFile: 'src/route.ts', line: 15 }] },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 2, maxGraphHits: 0 });
    expect(out).toHaveLength(1);
  });
});

describe('enrichWithGraphWalk — one-hop walk', () => {
  it('surfaces a caller symbol the query alone would have missed', () => {
    const graph = mockGraph({
      callers: { requireAuth: [{ callerFile: 'src/route.ts', line: 15 }] },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 1, maxGraphHits: 5 });
    expect(out).toHaveLength(2);
    const caller = out.find((e) => e.name === 'handleLogin');
    expect(caller).toBeDefined();
    expect(caller!.relationship).toMatch(/graph: called-by \(1 hop from requireAuth\)/);
    // Decayed score: 0.9 * 0.5^1 = 0.45
    expect(caller!.score).toBeCloseTo(0.45, 2);
  });

  it('skips caller sites that do not resolve to a containing symbol', () => {
    const graph = mockGraph({
      callers: { requireAuth: [{ callerFile: 'src/route.ts', line: 99 }] }, // line outside any symbol
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 1, maxGraphHits: 5 });
    expect(out).toHaveLength(1); // just the direct hit; caller skipped
  });

  it('never surfaces the direct hit twice (seen-set dedup)', () => {
    const graph = mockGraph({
      callers: { requireAuth: [{ callerFile: 'src/auth.ts', line: 15 }] },
      symbolsInFile: {
        'src/auth.ts': [
          { qualifiedName: 'requireAuth', name: 'requireAuth', type: 'function', startLine: 10, endLine: 30 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 1, maxGraphHits: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].relationship).toMatch(/^vector:/); // still the direct hit, not a walk-duplicate
  });
});

describe('enrichWithGraphWalk — depth caps + budget', () => {
  it('honors maxDepth: depth=1 stops at 1 hop even when 2-hop callers exist', () => {
    const graph = mockGraph({
      callers: {
        requireAuth: [{ callerFile: 'src/route.ts', line: 15 }],
        handleLogin: [{ callerFile: 'src/app.ts', line: 40 }], // 2-hop from requireAuth
      },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
        'src/app.ts': [
          { qualifiedName: 'registerRoutes', name: 'registerRoutes', type: 'function', startLine: 30, endLine: 50 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 1, maxGraphHits: 10 });
    expect(out.find((e) => e.name === 'handleLogin')).toBeDefined();
    expect(out.find((e) => e.name === 'registerRoutes')).toBeUndefined();
  });

  it('honors maxDepth: depth=2 surfaces 2-hop callers with 0.5^2 = 0.25 decay', () => {
    const graph = mockGraph({
      callers: {
        requireAuth: [{ callerFile: 'src/route.ts', line: 15 }],
        handleLogin: [{ callerFile: 'src/app.ts', line: 40 }],
      },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
        'src/app.ts': [
          { qualifiedName: 'registerRoutes', name: 'registerRoutes', type: 'function', startLine: 30, endLine: 50 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 2, maxGraphHits: 10 });
    const two = out.find((e) => e.name === 'registerRoutes');
    expect(two).toBeDefined();
    expect(two!.score).toBeCloseTo(0.9 * 0.25, 2);
    expect(two!.relationship).toMatch(/\(2 hops from/);
  });

  it('stops the walk when maxGraphHits is exhausted', () => {
    const graph = mockGraph({
      callers: {
        requireAuth: [
          { callerFile: 'src/a.ts', line: 5 },
          { callerFile: 'src/b.ts', line: 5 },
          { callerFile: 'src/c.ts', line: 5 },
          { callerFile: 'src/d.ts', line: 5 },
        ],
      },
      symbolsInFile: {
        'src/a.ts': [{ qualifiedName: 'a', name: 'a', type: 'function', startLine: 1, endLine: 10 }],
        'src/b.ts': [{ qualifiedName: 'b', name: 'b', type: 'function', startLine: 1, endLine: 10 }],
        'src/c.ts': [{ qualifiedName: 'c', name: 'c', type: 'function', startLine: 1, endLine: 10 }],
        'src/d.ts': [{ qualifiedName: 'd', name: 'd', type: 'function', startLine: 1, endLine: 10 }],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 1, maxGraphHits: 2 });
    // 1 direct hit + 2 graph hits (budget cap) = 3
    expect(out).toHaveLength(3);
  });
});

describe('enrichWithGraphWalk — ordering + overlap', () => {
  it('sorts by descending score: direct hits stay above graph hops', () => {
    const graph = mockGraph({
      callers: { requireAuth: [{ callerFile: 'src/route.ts', line: 15 }] },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
      },
    });
    const out = enrichWithGraphWalk([directHit()], graph, { maxDepth: 1, maxGraphHits: 5 });
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
    expect(out[0].relationship).toMatch(/^vector:/);
  });

  it('does not double-surface a caller reached from two overlapping starts', () => {
    const graph = mockGraph({
      callers: {
        requireAuth: [{ callerFile: 'src/route.ts', line: 15 }],
        validateToken: [{ callerFile: 'src/route.ts', line: 15 }], // same containing symbol
      },
      symbolsInFile: {
        'src/route.ts': [
          { qualifiedName: 'handleLogin', name: 'handleLogin', type: 'function', startLine: 10, endLine: 20 },
        ],
      },
    });
    const out = enrichWithGraphWalk(
      [directHit(), directHit({ qualifiedName: 'validateToken', name: 'validateToken' })],
      graph,
      { maxDepth: 1, maxGraphHits: 10 },
    );
    const logins = out.filter((e) => e.name === 'handleLogin');
    expect(logins).toHaveLength(1);
  });
});
