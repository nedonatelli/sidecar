import { describe, it, expect } from 'vitest';
import {
  contextPrecisionAtK,
  contextRecallAtK,
  f1ScoreAtK,
  reciprocalRank,
  scoreQuery,
  aggregateScorecards,
  aggregate,
} from './metrics.js';
import type { EvalHit } from './harness.js';

/**
 * Unit tests for RAG-eval metric functions (v0.62 e.2). The tests
 * below hand-build `EvalHit[]` fixtures to exercise each metric
 * independently of the retrieval pipeline — this keeps metric bugs
 * from being confounded with retrieval bugs when a regression
 * surfaces downstream.
 */

function hit(id: string, rank: number, kind = 'function'): EvalHit {
  return {
    symbolId: id,
    filePath: id.split('::')[0] ?? id,
    qualifiedName: id.split('::')[1] ?? id,
    name: id.split('::')[1] ?? id,
    kind,
    rank,
    score: 1 - rank * 0.1,
    relationship: 'vector',
  };
}

describe('contextPrecisionAtK', () => {
  it('returns 1 when every top-K hit is relevant', () => {
    const hits = [hit('a::1', 0), hit('a::2', 1), hit('a::3', 2)];
    const relevant = ['a::1', 'a::2', 'a::3'];
    expect(contextPrecisionAtK(hits, relevant, 3)).toBeCloseTo(1);
  });

  it('returns 0 when no top-K hit is relevant', () => {
    const hits = [hit('a::1', 0), hit('a::2', 1), hit('a::3', 2)];
    const relevant = ['x::1', 'y::2'];
    expect(contextPrecisionAtK(hits, relevant, 3)).toBe(0);
  });

  it('computes the correct fraction for partial overlap', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1), hit('c::1', 2), hit('d::1', 3)];
    const relevant = ['a::1', 'c::1']; // 2 of top-4 relevant
    expect(contextPrecisionAtK(hits, relevant, 4)).toBeCloseTo(0.5);
  });

  it('clamps k to hit count (cannot under-fetch penalize)', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1)];
    const relevant = ['a::1', 'b::1'];
    // k=10 but only 2 hits — precision is 2/2 = 1, not 2/10.
    expect(contextPrecisionAtK(hits, relevant, 10)).toBe(1);
  });

  it('returns 0 for an empty hit list', () => {
    expect(contextPrecisionAtK([], ['a::1'], 5)).toBe(0);
  });
});

describe('contextRecallAtK', () => {
  it('returns 1 when every relevant item is in top-K', () => {
    const hits = [hit('a::1', 0), hit('a::2', 1), hit('b::1', 2)];
    const relevant = ['a::1', 'a::2'];
    expect(contextRecallAtK(hits, relevant, 3)).toBe(1);
  });

  it('returns 0.5 when half the relevant items are in top-K', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1)];
    const relevant = ['a::1', 'a::2', 'a::3', 'a::4'];
    expect(contextRecallAtK(hits, relevant, 2)).toBeCloseTo(0.25);
  });

  it('returns 1 vacuously when the relevant set is empty', () => {
    const hits = [hit('a::1', 0)];
    expect(contextRecallAtK(hits, [], 5)).toBe(1);
  });

  it('counts items outside top-K as not retrieved', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1), hit('relevant::1', 2)];
    const relevant = ['relevant::1'];
    // k=2: relevant::1 is at rank 2 (index 2), out of top-2 window.
    expect(contextRecallAtK(hits, relevant, 2)).toBe(0);
    expect(contextRecallAtK(hits, relevant, 3)).toBe(1);
  });
});

describe('f1ScoreAtK', () => {
  it('equals 1 when precision and recall are both 1', () => {
    const hits = [hit('a::1', 0), hit('a::2', 1)];
    const relevant = ['a::1', 'a::2'];
    expect(f1ScoreAtK(hits, relevant, 2)).toBeCloseTo(1);
  });

  it('is the harmonic mean of precision and recall', () => {
    // precision = 1/2, recall = 1/2 → F1 = 1/2
    const hits = [hit('a::1', 0), hit('b::1', 1)];
    const relevant = ['a::1', 'c::1'];
    expect(f1ScoreAtK(hits, relevant, 2)).toBeCloseTo(0.5);
  });

  it('returns 0 when both precision and recall are 0', () => {
    const hits = [hit('a::1', 0)];
    const relevant = ['b::1'];
    expect(f1ScoreAtK(hits, relevant, 1)).toBe(0);
  });
});

describe('reciprocalRank', () => {
  it('returns 1 when the first hit is relevant', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1)];
    expect(reciprocalRank(hits, ['a::1'])).toBe(1);
  });

  it('returns 1/2 when the first relevant hit is at rank 2', () => {
    const hits = [hit('b::1', 0), hit('a::1', 1)];
    expect(reciprocalRank(hits, ['a::1'])).toBeCloseTo(0.5);
  });

  it('returns 0 when no hit is relevant', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1)];
    expect(reciprocalRank(hits, ['c::1'])).toBe(0);
  });

  it('only counts the FIRST relevant hit', () => {
    // Multiple relevant items — score reflects the earliest rank.
    const hits = [hit('a::1', 0), hit('a::2', 1), hit('a::3', 2)];
    expect(reciprocalRank(hits, ['a::2', 'a::3'])).toBeCloseTo(0.5);
  });
});

describe('scoreQuery + aggregateScorecards', () => {
  it('bundles all metrics into one scorecard', () => {
    const hits = [hit('a::1', 0), hit('b::1', 1), hit('a::2', 2)];
    const relevant = ['a::1', 'a::2'];
    const card = scoreQuery('test', hits, relevant, 3);
    expect(card.name).toBe('test');
    expect(card.precisionAtK).toBeCloseTo(2 / 3);
    expect(card.recallAtK).toBe(1);
    expect(card.reciprocalRank).toBe(1);
    expect(card.relevantCount).toBe(2);
    expect(card.retrievedInTopK).toBe(2);
  });

  it('aggregates scorecards via macro averaging', () => {
    // Case A: 2 hits, only 1 relevant — precision 0.5, recall 1.0.
    // Case B: 1 hit, that hit is relevant — precision 1.0, recall 1.0.
    // Mean: precision = (0.5 + 1.0) / 2 = 0.75; recall = 1.0; RR = 1.0.
    const hitsA = [hit('x::1', 0), hit('x::2', 1)];
    const hitsB = [hit('y::1', 0)];
    const cardA = scoreQuery('A', hitsA, ['x::1'], 2);
    const cardB = scoreQuery('B', hitsB, ['y::1'], 1);
    const agg = aggregateScorecards([cardA, cardB]);
    expect(agg.caseCount).toBe(2);
    expect(agg.meanPrecisionAtK).toBeCloseTo(0.75);
    expect(agg.meanRecallAtK).toBe(1);
    expect(agg.meanReciprocalRank).toBe(1);
  });

  it('aggregate on empty input returns zeros, not NaN', () => {
    const agg = aggregateScorecards([]);
    expect(agg).toEqual({
      meanPrecisionAtK: 0,
      meanRecallAtK: 0,
      meanF1AtK: 0,
      meanReciprocalRank: 0,
      caseCount: 0,
    });
  });
});

describe('aggregate helper', () => {
  it('mean-averages a metric across case results', () => {
    const cases = [
      { hits: [hit('a::1', 0)], relevantIds: ['a::1'] }, // precision = 1
      { hits: [hit('x::1', 0)], relevantIds: ['a::1'] }, // precision = 0
    ];
    const mean = aggregate(cases, (h, r) => contextPrecisionAtK(h, r, 1));
    expect(mean).toBeCloseTo(0.5);
  });

  it('returns 0 on empty input', () => {
    expect(aggregate([], () => 1)).toBe(0);
  });
});
