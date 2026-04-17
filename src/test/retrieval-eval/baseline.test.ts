import { describe, it, expect, beforeAll } from 'vitest';
import { buildFixtureHarness, runGoldenQuery } from './harness.js';
import { GOLDEN_CASES } from './goldenCases.js';
import { scoreQuery, aggregateScorecards, type QueryScorecard } from './metrics.js';

/**
 * Baseline-quality CI ratchet for retrieval (v0.62 e.2). Runs every
 * golden case, computes per-query scorecards + aggregate metrics,
 * and asserts the aggregate stays at-or-above hard-coded
 * thresholds. Regressions that drop precision@K or recall@K below
 * the floor fail the build, same as the coverage ratchet in
 * `vitest.config.ts`.
 *
 * Thresholds are pinned slightly below the current observed baseline
 * so CI doesn't flip red on normal variance. Ratchet them up (not
 * down) whenever a change improves retrieval quality — movement in
 * the ratchet direction is itself a useful signal in code review.
 *
 * The thresholds are deliberately aggregate-level, not per-query:
 * individual queries can fluctuate with pipeline changes without
 * forcing a false-positive CI failure, as long as the corpus as a
 * whole doesn't regress.
 */

// Cap the top-K window scorecards use. Matches the default topK=5
// that most golden cases declare — picking a different K here would
// mask regressions in the cases that set topK=10 (kind-filter,
// path-filter scenarios); pick the MAX so every case's relevant
// set is inside the scoring window.
const SCORING_K = 10;

/**
 * Floor thresholds — every one of these must hold for CI to stay
 * green. Tuned a few points below the current baseline so normal
 * variance (pipeline churn, fixture adjustments, new golden cases)
 * doesn't trip them on unrelated changes.
 *
 * Current baseline (recorded 2026-04-17 against v0.62 e.1 fixture):
 *   meanPrecisionAtK:     0.492
 *   meanRecallAtK:        1.000
 *   meanF1AtK:            0.593
 *   meanReciprocalRank:   0.939
 *
 * Ratchet upward when a retrieval improvement lands (Merkle prune,
 * better chunking, reranker); keep this comment in sync so future
 * readers can tell whether the current thresholds are load-bearing
 * or stale. Movement in the ratchet direction is itself a useful
 * signal in code review.
 */
export const RETRIEVAL_THRESHOLDS = {
  meanPrecisionAtK: 0.45,
  meanRecallAtK: 0.95,
  meanF1AtK: 0.55,
  meanReciprocalRank: 0.9,
};

describe('retrieval-eval: aggregate metrics ratchet (v0.62 e.2)', () => {
  let scorecards: QueryScorecard[];

  beforeAll(async () => {
    const harness = await buildFixtureHarness();
    scorecards = [];
    for (const c of GOLDEN_CASES) {
      const hits = await runGoldenQuery(c.query, c, harness);
      scorecards.push(scoreQuery(c.name, hits, c.relevantSymbolIds, SCORING_K));
    }
  });

  it('produces one scorecard per golden case', () => {
    expect(scorecards).toHaveLength(GOLDEN_CASES.length);
  });

  it('mean precision@K stays at or above the ratchet floor', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanPrecisionAtK).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanPrecisionAtK);
  });

  it('mean recall@K stays at or above the ratchet floor', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanRecallAtK).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanRecallAtK);
  });

  it('mean F1@K stays at or above the ratchet floor', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanF1AtK).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanF1AtK);
  });

  it('mean reciprocal rank stays at or above the ratchet floor', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanReciprocalRank).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanReciprocalRank);
  });

  it('reports per-case scorecards for ratchet-tuning visibility', () => {
    // Not an assertion — a log hook that makes the per-query
    // numbers visible in `vitest --reporter verbose` output so a
    // reviewer can see which cases drive the aggregate score up or
    // down after a retrieval change.
    const agg = aggregateScorecards(scorecards);
    const rows = scorecards.map(
      (s) =>
        `  ${s.name.padEnd(60)}  P=${s.precisionAtK.toFixed(2)}  R=${s.recallAtK.toFixed(2)}  F1=${s.f1AtK.toFixed(2)}  RR=${s.reciprocalRank.toFixed(2)}`,
    );
    console.log(
      [
        '',
        'Retrieval eval scorecard (aggregate + per-case):',
        `  AGGREGATE: meanP=${agg.meanPrecisionAtK.toFixed(3)} meanR=${agg.meanRecallAtK.toFixed(3)} meanF1=${agg.meanF1AtK.toFixed(3)} meanRR=${agg.meanReciprocalRank.toFixed(3)}`,
        ...rows,
      ].join('\n'),
    );
    expect(agg.caseCount).toBe(GOLDEN_CASES.length);
  });
});
