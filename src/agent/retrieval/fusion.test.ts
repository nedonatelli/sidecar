import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from './fusion';
import { RetrievalHit } from './retriever';
import { fuseRetrievers } from './index';

function hit(id: string, source: string, score = 0): RetrievalHit {
  return { id, source, score, content: `[${source}] ${id}` };
}

describe('reciprocalRankFusion', () => {
  it('ranks a hit shared across two lists above a top-1 hit from a single list', () => {
    const a = [hit('solo-a', 'docs'), hit('shared', 'docs')];
    const b = [hit('solo-b', 'memory'), hit('shared', 'memory')];
    const fused = reciprocalRankFusion([a, b]);
    expect(fused[0].id).toBe('shared');
  });

  it('keeps content from the first list when the same id appears in multiple', () => {
    const a = [hit('x', 'docs')];
    const b = [hit('x', 'memory')];
    const fused = reciprocalRankFusion([a, b]);
    expect(fused[0].content).toBe('[docs] x');
  });

  it('preserves ordering within a single list', () => {
    const a = [hit('first', 'docs'), hit('second', 'docs'), hit('third', 'docs')];
    const fused = reciprocalRankFusion([a]);
    expect(fused.map((h) => h.id)).toEqual(['first', 'second', 'third']);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  it('respects the k dampening constant so rank-1 items do not dominate by huge margins', () => {
    const listA = [hit('a1', 'docs'), hit('a2', 'docs')];
    const listB = [hit('b1', 'memory'), hit('a2', 'memory')];
    const fused = reciprocalRankFusion([listA, listB], 60);
    const a2 = fused.find((h) => h.id === 'a2')!;
    const a1 = fused.find((h) => h.id === 'a1')!;
    expect(a2.score).toBeGreaterThan(a1.score);
  });
});

describe('fuseRetrievers', () => {
  it('skips retrievers that report not ready', async () => {
    const ready = {
      name: 'docs',
      isReady: () => true,
      retrieve: async () => [hit('x', 'docs')],
    };
    const notReady = {
      name: 'memory',
      isReady: () => false,
      retrieve: async () => [hit('y', 'memory')],
    };
    const fused = await fuseRetrievers([ready, notReady], 'query', 5);
    expect(fused.map((h) => h.id)).toEqual(['x']);
  });

  it('swallows retriever errors and returns partial results', async () => {
    const bad = {
      name: 'docs',
      isReady: () => true,
      retrieve: async () => {
        throw new Error('boom');
      },
    };
    const good = {
      name: 'memory',
      isReady: () => true,
      retrieve: async () => [hit('ok', 'memory')],
    };
    const fused = await fuseRetrievers([bad, good], 'query', 5);
    expect(fused.map((h) => h.id)).toEqual(['ok']);
  });

  it('truncates to topK', async () => {
    const many = {
      name: 'docs',
      isReady: () => true,
      retrieve: async () => Array.from({ length: 10 }, (_, i) => hit(`h${i}`, 'docs')),
    };
    const fused = await fuseRetrievers([many], 'q', 3);
    expect(fused).toHaveLength(3);
  });
});
