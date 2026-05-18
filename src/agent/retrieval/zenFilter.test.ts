import { describe, it, expect } from 'vitest';
import { applyZenFilter } from './zenFilter.js';
import type { RetrievalHit } from './retriever.js';

function makeHit(id: string, score: number): RetrievalHit {
  return { id, score, content: `content-${id}`, source: 'test' };
}

describe('applyZenFilter', () => {
  it('returns all hits when minScore is 0', () => {
    const hits = [makeHit('a', 0.1), makeHit('b', 0.5), makeHit('c', 0.9)];
    expect(applyZenFilter(hits, 0)).toEqual(hits);
  });

  it('filters out hits below threshold', () => {
    const hits = [makeHit('a', 0.1), makeHit('b', 0.35), makeHit('c', 0.9)];
    const result = applyZenFilter(hits, 0.35);
    expect(result).toHaveLength(2);
    expect(result.map((h) => h.id)).toEqual(['b', 'c']);
  });

  it('returns empty array when all hits are below threshold', () => {
    const hits = [makeHit('a', 0.1), makeHit('b', 0.2)];
    expect(applyZenFilter(hits, 0.5)).toEqual([]);
  });

  it('does not mutate input array', () => {
    const hits = [makeHit('a', 0.1), makeHit('b', 0.8)];
    const copy = [...hits];
    applyZenFilter(hits, 0.5);
    expect(hits).toEqual(copy);
  });

  it('export is accessible from src/agent/retrieval/index.ts', async () => {
    const mod = await import('./index.js');
    expect(typeof (mod as Record<string, unknown>).applyZenFilter).toBe('function');
  });
});
