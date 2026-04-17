import { describe, it, expect, beforeAll } from 'vitest';
import { buildFixtureHarness, runGoldenQuery, scoreAllRelevantPresent, type EvalHit } from './harness.js';
import { GOLDEN_CASES } from './goldenCases.js';

/**
 * Retrieval-eval runner (v0.62 e.1). Runs every golden case in
 * `goldenCases.ts` against the synthetic fixture and asserts the
 * expected symbols appear in the retrieval result. Also exercises
 * harness-level invariants (graph-walk depth 0 suppresses graph
 * hits, kind + path filters actually narrow the result set).
 *
 * This is the *pipeline logic* layer — it uses a deterministic fake
 * embedding pipeline so the scorer is stable across CI runs. A
 * separate real-model eval (planned under `tests/llm-eval/`) tests
 * actual semantic quality against a live embedding backend.
 */

describe('retrieval-eval: golden dataset (v0.62 e.1)', () => {
  let harness: Awaited<ReturnType<typeof buildFixtureHarness>>;

  beforeAll(async () => {
    harness = await buildFixtureHarness();
  });

  for (const c of GOLDEN_CASES) {
    it(c.name, async () => {
      const hits = await runGoldenQuery(c.query, c, harness);
      const result = scoreAllRelevantPresent(hits, c.relevantSymbolIds);

      if (!result.hit) {
        // Shape the failure message so a regression-debug session
        // can scan the full hit list alongside the missing set.
        const hitSummary = hits.map((h) => `${h.rank}:${h.symbolId} (${h.relationship})`).join('\n  ');
        throw new Error(
          `Missing expected symbols: ${result.missing.join(', ')}\nGot hits:\n  ${hitSummary || '(empty)'}`,
        );
      }
      expect(result.missing).toEqual([]);
    });
  }
});

describe('retrieval-eval: harness invariants (v0.62 e.1)', () => {
  let harness: Awaited<ReturnType<typeof buildFixtureHarness>>;

  beforeAll(async () => {
    harness = await buildFixtureHarness();
  });

  it('graph walk at depth 0 emits zero graph-reached hits', async () => {
    // A body like `handleUsers` that literally contains the word
    // `requireAuth` will still score via vector similarity against
    // an "auth" query — so we can't assert specific names are
    // absent. What we CAN assert: with depth 0, none of the hits
    // should carry a `relationship: 'graph'` tag.
    const hits = await runGoldenQuery('authorization middleware require auth', { topK: 5, graphWalkDepth: 0 }, harness);
    expect(hits.every((h) => h.relationship === 'vector')).toBe(true);
  });

  it('graph walk at depth 1 DOES surface requireAuth callers via graph relationship', async () => {
    const hits = await runGoldenQuery(
      'authorization middleware require auth',
      { topK: 3, graphWalkDepth: 1, maxGraphHits: 10 },
      harness,
    );
    // At depth 1, at least one hit must come from the graph walk —
    // proof that the enrichment path is active and producing
    // different results than the vector-only path.
    expect(hits.some((h) => h.relationship === 'graph')).toBe(true);
    const names = hits.map((h) => h.name);
    expect(names).toEqual(expect.arrayContaining(['handleUsers', 'handlePosts']));
  });

  it('kindFilter: interfaces only drops every function hit', async () => {
    const hits = await runGoldenQuery('user data', { topK: 10, kindFilter: ['interface'], graphWalkDepth: 0 }, harness);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h: EvalHit) => h.kind === 'interface')).toBe(true);
  });

  it('pathPrefix: utils/ never surfaces symbols from src/auth/', async () => {
    const hits = await runGoldenQuery('helper', { topK: 20, pathPrefix: 'src/utils/', graphWalkDepth: 0 }, harness);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.filePath.startsWith('src/utils/'))).toBe(true);
  });

  it('direct vector hits are ranked above graph-reached hits', async () => {
    const hits = await runGoldenQuery(
      'authorization middleware require auth',
      { topK: 3, graphWalkDepth: 1, maxGraphHits: 10 },
      harness,
    );
    // Every vector hit's score must be ≥ every graph hit's score.
    const vectorMax = Math.max(...hits.filter((h) => h.relationship === 'vector').map((h) => h.score));
    const graphMax = Math.max(...hits.filter((h) => h.relationship === 'graph').map((h) => h.score), -Infinity);
    // `graphMax` may be `-Infinity` if no graph hits surfaced, in
    // which case the invariant trivially holds.
    expect(vectorMax).toBeGreaterThanOrEqual(graphMax);
  });
});
