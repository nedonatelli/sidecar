/**
 * Trim a ranked retrieval result at the point its scores fall off a cliff.
 *
 * Injecting the top 6 symbols costs a small local model 90% -> 55% on a module
 * of near-identical validators (p=0.031), and costs nothing at all on a module
 * of distinct services (15/20 in both arms). The retriever is not at fault in
 * either case — on the harmful one it ranks the CORRECT symbol first, then
 * appends five siblings within 0.04 of it. What reaches the model is a set of
 * equally plausible candidates, so retrieval manufactures ambiguity that the
 * task did not have.
 *
 * The discriminating statistic is NOT "is #1 ahead of #2". Measured:
 *
 *   harmful   0.6694 0.6473 0.6431 0.6359 0.6316 0.6289   gap #1->#2 = 0.0222
 *   harmless  0.6456 0.6111 0.2346 0.1795 0.1559 0.1416   gap #1->#2 = 0.0345
 *
 * The harmless case has the LARGER gap, because a method's nearest neighbour is
 * the class containing it — similar and genuinely useful. Gating on that gap
 * trims exactly backwards. What separates them is whether the ranking ever
 * falls off: max consecutive drop 0.0222 (no cliff) versus 0.3765 (a cliff
 * after the second hit).
 *
 * So: keep everything down to the cliff. With no cliff, the retriever has not
 * discriminated, and only the leader survives.
 */

/** Smallest consecutive drop treated as a cliff. Measured 0.0222 vs 0.3765 — an
 *  order of magnitude of margin either side, so the exact value is not delicate.
 *  Re-measure with `bench/swe/retrievalSpread.eval.ts` if the embedder changes. */
export const MIN_CLIFF = 0.1;

export interface CliffTrim {
  /** How many of the ranked hits should reach the model. */
  keep: number;
  reason: 'cliff' | 'undifferentiated' | 'too-few';
  /** Largest consecutive drop seen, for logging. */
  maxDrop: number;
}

export function trimAtSimilarityCliff(similarities: number[], minCliff: number = MIN_CLIFF): CliffTrim {
  if (similarities.length <= 1) return { keep: similarities.length, reason: 'too-few', maxDrop: 0 };

  let maxDrop = -Infinity;
  let cliffAt = 0;
  for (let i = 0; i < similarities.length - 1; i++) {
    const drop = similarities[i] - similarities[i + 1];
    if (drop > maxDrop) {
      maxDrop = drop;
      cliffAt = i;
    }
  }

  // A cliff means the hits above it are a coherent region and the ones below
  // are a different subject; keep the region.
  if (maxDrop >= minCliff) return { keep: cliffAt + 1, reason: 'cliff', maxDrop };

  // No cliff: every candidate is about as good as the leader, which is the
  // shape that measured harmful. Send the leader alone.
  return { keep: 1, reason: 'undifferentiated', maxDrop };
}
