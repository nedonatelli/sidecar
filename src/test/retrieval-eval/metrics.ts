/**
 * Deterministic RAG retrieval metrics (v0.62 e.2). The scorer in
 * `harness.ts` answers a binary question ("are all expected symbols
 * in the result?"); this module layers the standard information-
 * retrieval metrics on top so regressions surface as small
 * movements in continuous numbers, not as a hard pass/fail flip.
 *
 * We implement the set-based variants (precision@k / recall@k)
 * rather than the rank-weighted RAGAs formulation because:
 *   - The set-based versions are easier to reason about in a
 *     regression-triage setting ("precision dropped 8pp" is
 *     interpretable; "weighted precision dropped 0.03" isn't).
 *   - Rank-weighted precision trips on ties more easily given our
 *     small golden dataset, and the golden cases already pin
 *     which symbols we expect to see regardless of ordering.
 *
 * For the LLM-as-judge metrics (Faithfulness, AnswerRelevancy) see
 * step e.3 — they live separately because they need a real model
 * and run under `npm run eval:llm`, not as part of the main suite.
 */

import type { EvalHit } from './harness.js';

/**
 * Precision@K — fraction of the top-K retrieved items that are
 * actually relevant. Ranges [0, 1]; 1.0 means every top-K hit is
 * relevant, 0.0 means none are.
 *
 * `k > hits.length` is treated as `k = hits.length` — you can't be
 * penalized for under-fetching when the system legitimately had
 * fewer than K candidates to offer.
 */
export function contextPrecisionAtK(hits: EvalHit[], relevantIds: string[], k: number): number {
  const topK = hits.slice(0, Math.min(k, hits.length));
  if (topK.length === 0) return 0;
  const relevant = new Set(relevantIds);
  const relevantHits = topK.filter((h) => relevant.has(h.symbolId)).length;
  return relevantHits / topK.length;
}

/**
 * Recall@K — fraction of the known-relevant items that appear in
 * the top-K. Ranges [0, 1]; 1.0 means every relevant item was
 * surfaced in the top-K window. If `relevantIds` is empty, recall
 * is vacuously 1.0 (nothing to find, can't miss anything) — this
 * matters for the `null-query` edge case where a query has no
 * expected answer set.
 */
export function contextRecallAtK(hits: EvalHit[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0) return 1;
  const topK = hits.slice(0, Math.min(k, hits.length));
  const retrieved = new Set(topK.map((h) => h.symbolId));
  const found = relevantIds.filter((id) => retrieved.has(id)).length;
  return found / relevantIds.length;
}

/**
 * F1@K — harmonic mean of precision and recall. Single number that
 * balances the two; useful for overall "is retrieval getting better
 * or worse?" tracking. Returns 0 if both precision and recall are 0
 * (the formula would be 0/0 otherwise).
 */
export function f1ScoreAtK(hits: EvalHit[], relevantIds: string[], k: number): number {
  const p = contextPrecisionAtK(hits, relevantIds, k);
  const r = contextRecallAtK(hits, relevantIds, k);
  if (p + r === 0) return 0;
  return (2 * p * r) / (p + r);
}

/**
 * Reciprocal Rank — `1 / rank` of the FIRST relevant hit. 1.0 means
 * the first hit was relevant; 0.5 means the second was; 0 means no
 * relevant hit appeared at all. Averaged across queries this gives
 * Mean Reciprocal Rank (MRR) — a standard IR metric that captures
 * "on average, how quickly does the system surface something
 * relevant?"
 *
 * Rank is 1-based (rank 1 → score 1.0) to match the IR literature.
 */
export function reciprocalRank(hits: EvalHit[], relevantIds: string[]): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < hits.length; i++) {
    if (relevant.has(hits[i].symbolId)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Aggregate score across multiple query results. Macro-averaging —
 * each query weighs equally, regardless of its relevant-set size.
 * This is the standard choice for small datasets where a single
 * big-relevant-set query shouldn't dominate the score.
 */
export function aggregate<T extends { hits: EvalHit[]; relevantIds: string[] }>(
  caseResults: T[],
  metric: (hits: EvalHit[], relevantIds: string[]) => number,
): number {
  if (caseResults.length === 0) return 0;
  const sum = caseResults.reduce((acc, c) => acc + metric(c.hits, c.relevantIds), 0);
  return sum / caseResults.length;
}

/**
 * Convenience wrapper that bundles precision@k, recall@k, F1@k,
 * and MRR into a single row. Useful for reporting — dump this
 * shape straight to a table and each row is one query's scorecard.
 */
export interface QueryScorecard {
  name: string;
  precisionAtK: number;
  recallAtK: number;
  f1AtK: number;
  reciprocalRank: number;
  /** How many relevant items were expected. */
  relevantCount: number;
  /** How many the system surfaced in the top-K. */
  retrievedInTopK: number;
}

export function scoreQuery(name: string, hits: EvalHit[], relevantIds: string[], k: number): QueryScorecard {
  const relevant = new Set(relevantIds);
  const topK = hits.slice(0, Math.min(k, hits.length));
  return {
    name,
    precisionAtK: contextPrecisionAtK(hits, relevantIds, k),
    recallAtK: contextRecallAtK(hits, relevantIds, k),
    f1AtK: f1ScoreAtK(hits, relevantIds, k),
    reciprocalRank: reciprocalRank(hits, relevantIds),
    relevantCount: relevantIds.length,
    retrievedInTopK: topK.filter((h) => relevant.has(h.symbolId)).length,
  };
}

/**
 * Aggregate scorecard — mean of each per-query metric. The corpus-
 * level view a CI gate reads from.
 */
export interface AggregateScorecard {
  meanPrecisionAtK: number;
  meanRecallAtK: number;
  meanF1AtK: number;
  meanReciprocalRank: number;
  caseCount: number;
}

export function aggregateScorecards(scorecards: QueryScorecard[]): AggregateScorecard {
  if (scorecards.length === 0) {
    return {
      meanPrecisionAtK: 0,
      meanRecallAtK: 0,
      meanF1AtK: 0,
      meanReciprocalRank: 0,
      caseCount: 0,
    };
  }
  const n = scorecards.length;
  const sum = (pick: (s: QueryScorecard) => number) => scorecards.reduce((a, s) => a + pick(s), 0);
  return {
    meanPrecisionAtK: sum((s) => s.precisionAtK) / n,
    meanRecallAtK: sum((s) => s.recallAtK) / n,
    meanF1AtK: sum((s) => s.f1AtK) / n,
    meanReciprocalRank: sum((s) => s.reciprocalRank) / n,
    caseCount: n,
  };
}
