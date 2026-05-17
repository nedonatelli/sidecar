import { describe, it, expect, vi } from 'vitest';
import { SidecarMdRetriever } from './sidecarMdRetriever.js';
import type { RetrievalHit } from './retriever.js';

function makeIndex(hits: RetrievalHit[], size = hits.length) {
  return {
    size: () => size,
    search: vi.fn(async (_query: string, _k: number, _minScore: number) => hits),
  };
}

describe('SidecarMdRetriever', () => {
  it('isReady returns false when index is empty', () => {
    const r = new SidecarMdRetriever(makeIndex([], 0) as never, 5, 0.3);
    expect(r.isReady()).toBe(false);
  });

  it('isReady returns true when index has entries', () => {
    const r = new SidecarMdRetriever(makeIndex([], 2) as never, 5, 0.3);
    expect(r.isReady()).toBe(true);
  });

  it('name is "sidecarMd"', () => {
    const r = new SidecarMdRetriever(makeIndex([]) as never, 5, 0.3);
    expect(r.name).toBe('sidecarMd');
  });

  it('retrieve delegates to index.search with min(k, topK)', async () => {
    const hit: RetrievalHit = { id: 'sidecarmd:build', score: 0.9, source: 'sidecarMd', content: 'build stuff' };
    const index = makeIndex([hit], 1);
    const r = new SidecarMdRetriever(index as never, 3, 0.3);

    const results = await r.retrieve('how do I build', 10);
    expect(results).toEqual([hit]);
    // k clamped to topK = 3
    expect(index.search).toHaveBeenCalledWith('how do I build', 3, 0.3);
  });

  it('respects caller k when smaller than topK', async () => {
    const index = makeIndex([], 2);
    const r = new SidecarMdRetriever(index as never, 10, 0.3);
    await r.retrieve('query', 2);
    expect(index.search).toHaveBeenCalledWith('query', 2, 0.3);
  });

  it('forwards minScore to index.search', async () => {
    const index = makeIndex([], 2);
    const r = new SidecarMdRetriever(index as never, 5, 0.45);
    await r.retrieve('query', 5);
    expect(index.search).toHaveBeenCalledWith('query', 5, 0.45);
  });
});
