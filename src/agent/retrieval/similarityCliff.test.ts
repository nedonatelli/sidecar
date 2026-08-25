import { describe, expect, it } from 'vitest';
import { trimAtSimilarityCliff, MIN_CLIFF } from './similarityCliff.js';

// The two measured distributions, verbatim from bench/swe/retrievalSpread.eval.ts.
const HARMFUL = [0.6694, 0.6473, 0.6431, 0.6359, 0.6316, 0.6289];
const HARMLESS = [0.6456, 0.6111, 0.2346, 0.1795, 0.1559, 0.1416];

describe('trimAtSimilarityCliff', () => {
  it('sends only the leader when nothing distinguishes the candidates', () => {
    const t = trimAtSimilarityCliff(HARMFUL);
    expect(t).toMatchObject({ keep: 1, reason: 'undifferentiated' });
    expect(t.maxDrop).toBeCloseTo(0.0221, 3);
  });

  it('keeps the coherent region above a cliff', () => {
    // The method and the class containing it, not the four unrelated services.
    const t = trimAtSimilarityCliff(HARMLESS);
    expect(t).toMatchObject({ keep: 2, reason: 'cliff' });
    expect(t.maxDrop).toBeCloseTo(0.3765, 3);
  });

  it('does not key on the gap between the top two', () => {
    // The whole point: the harmless distribution has the LARGER #1->#2 gap, so a
    // gate built on that statistic trims the wrong one.
    const harmfulGap = HARMFUL[0] - HARMFUL[1];
    const harmlessGap = HARMLESS[0] - HARMLESS[1];
    expect(harmlessGap).toBeGreaterThan(harmfulGap);
    expect(trimAtSimilarityCliff(HARMFUL).keep).toBeLessThan(trimAtSimilarityCliff(HARMLESS).keep);
  });

  it('passes through results too short to have a shape', () => {
    expect(trimAtSimilarityCliff([])).toMatchObject({ keep: 0, reason: 'too-few' });
    expect(trimAtSimilarityCliff([0.9])).toMatchObject({ keep: 1, reason: 'too-few' });
  });

  it('keeps everything when the cliff is at the end', () => {
    expect(trimAtSimilarityCliff([0.9, 0.88, 0.87, 0.1])).toMatchObject({ keep: 3, reason: 'cliff' });
  });

  it('treats a uniformly low-scoring set as undifferentiated', () => {
    expect(trimAtSimilarityCliff([0.21, 0.2, 0.19, 0.18])).toMatchObject({ keep: 1, reason: 'undifferentiated' });
  });

  it('honors an explicit threshold', () => {
    // The threshold decides whether a drop counts as a cliff at all, not where
    // the cliff is: the same 0.35 drop is a cliff at the default and merely
    // noise at 0.5.
    const scores = [0.9, 0.85, 0.5];
    expect(trimAtSimilarityCliff(scores, MIN_CLIFF)).toMatchObject({ keep: 2, reason: 'cliff' });
    expect(trimAtSimilarityCliff(scores, 0.5)).toMatchObject({ keep: 1, reason: 'undifferentiated' });
  });
});
