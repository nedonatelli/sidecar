import type { RetrievalHit } from './retriever.js';

export function applyZenFilter(hits: RetrievalHit[], minScore: number): RetrievalHit[] {
  if (minScore <= 0) return hits;
  return hits.filter((h) => h.score >= minScore);
}
