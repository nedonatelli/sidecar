import { RetrievalHit } from './retriever';

/**
 * Reciprocal-rank fusion. Merges hit lists from multiple retrievers into
 * a single ranking using the standard formula:
 *
 *   rrfScore(hit) = Σ 1 / (k + rank)   over every list that contains hit
 *
 * where `rank` is 1-indexed. The constant `k` (default 60, per the original
 * Cormack/Clarke/Büttcher paper) dampens the contribution of low-ranked
 * items so that a single very-high-rank hit from one retriever cannot
 * dominate a hit that's top-ranked in two retrievers.
 *
 * Hits are deduplicated by `id`. When the same id appears in multiple
 * lists we keep the first occurrence's rendered `content` (the idea being
 * that the first list we pass is the most authoritative renderer for that
 * item — callers should order their lists accordingly, or pre-dedup if
 * different renderers matter).
 */
export function reciprocalRankFusion(lists: RetrievalHit[][], k: number = 60): RetrievalHit[] {
  const fused = new Map<string, { hit: RetrievalHit; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank];
      const contribution = 1 / (k + rank + 1);
      const existing = fused.get(hit.id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(hit.id, { hit, score: contribution });
      }
    }
  }

  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.hit, score: entry.score }));
}
