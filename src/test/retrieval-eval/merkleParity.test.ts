import { describe, it, expect, beforeAll } from 'vitest';
import { buildFixtureHarness, runGoldenQuery } from './harness.js';
import { GOLDEN_CASES } from './goldenCases.js';
import { scoreQuery, aggregateScorecards, type QueryScorecard } from './metrics.js';
import { RETRIEVAL_THRESHOLDS } from './baseline.test.js';

/**
 * Merkle descent parity eval (v0.62 d.3). Re-runs every golden case
 * with the Merkle tree wired and asserts the aggregate retrieval
 * quality stays at-or-above the same ratchet floors the non-Merkle
 * baseline hits. Purpose: prove that descent-based pruning doesn't
 * regress quality on the cases we've committed to getting right.
 *
 * If a Merkle change ever drops the aggregate below a floor (e.g.
 * the descent picks too-few files for some query kind), the gate
 * fires before the change ships. If the descent IMPROVES aggregate
 * quality (by letting retrieval focus on the right subtree), the
 * parity test still passes — the threshold is a floor, not an
 * equality.
 */

const SCORING_K = 10;

describe('retrieval-eval: Merkle descent parity (v0.62 d.3)', () => {
  let scorecards: QueryScorecard[];

  beforeAll(async () => {
    const harness = await buildFixtureHarness({ withMerkle: true });
    scorecards = [];
    for (const c of GOLDEN_CASES) {
      const hits = await runGoldenQuery(c.query, c, harness);
      scorecards.push(scoreQuery(c.name, hits, c.relevantSymbolIds, SCORING_K));
    }
  });

  it('Merkle tree is populated by the harness', async () => {
    // Sanity: the harness wired a tree and the activation flow
    // populated it before scoring — if this trips, the Merkle wiring
    // in `buildFixtureHarness` regressed and the parity numbers
    // below would be meaningless.
    const harness = await buildFixtureHarness({ withMerkle: true });
    expect(harness.merkleTree).not.toBeNull();
    expect(harness.merkleTree!.getLeafCount()).toBeGreaterThan(0);
    expect(harness.merkleTree!.getRootHash()).not.toBe('');
  });

  it('aggregate mean-precision stays at-or-above ratchet floor with descent on', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanPrecisionAtK).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanPrecisionAtK);
  });

  it('aggregate mean-recall stays at-or-above ratchet floor with descent on', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanRecallAtK).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanRecallAtK);
  });

  it('aggregate mean-F1 stays at-or-above ratchet floor with descent on', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanF1AtK).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanF1AtK);
  });

  it('aggregate mean-RR stays at-or-above ratchet floor with descent on', () => {
    const agg = aggregateScorecards(scorecards);
    expect(agg.meanReciprocalRank).toBeGreaterThanOrEqual(RETRIEVAL_THRESHOLDS.meanReciprocalRank);
  });

  it('emits per-case Merkle scorecards for review-time diff against the non-Merkle baseline', () => {
    const agg = aggregateScorecards(scorecards);
    const rows = scorecards.map(
      (s) =>
        `  ${s.name.padEnd(60)}  P=${s.precisionAtK.toFixed(2)}  R=${s.recallAtK.toFixed(2)}  F1=${s.f1AtK.toFixed(2)}  RR=${s.reciprocalRank.toFixed(2)}`,
    );
    console.log(
      [
        '',
        'Retrieval eval with Merkle descent enabled:',
        `  AGGREGATE: meanP=${agg.meanPrecisionAtK.toFixed(3)} meanR=${agg.meanRecallAtK.toFixed(3)} meanF1=${agg.meanF1AtK.toFixed(3)} meanRR=${agg.meanReciprocalRank.toFixed(3)}`,
        ...rows,
      ].join('\n'),
    );
    expect(agg.caseCount).toBe(GOLDEN_CASES.length);
  });
});
