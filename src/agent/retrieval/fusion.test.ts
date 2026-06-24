import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from './fusion';
import { RetrievalHit } from './retriever';
import { fuseRetrievers, renderFusedContext } from './index';

function hit(id: string, source: string, score = 0): RetrievalHit {
  return { id, source, score, content: `[${source}] ${id}` };
}

describe('renderFusedContext', () => {
  const codeHit = (filePath: string, title: string, body: string): RetrievalHit => ({
    id: `pki:${filePath}`,
    score: 1,
    source: 'pki',
    content: body,
    filePath,
    title,
  });
  const docHit = (id: string, body: string): RetrievalHit => ({ id, score: 1, source: 'doc', content: body });

  it('full mode injects every hit body verbatim', () => {
    const out = renderFusedContext([codeHit('calc.py', 'add', 'def add(): ...full body...')], '## Ctx', 'full');
    expect(out).toContain('def add(): ...full body...');
  });

  it('reference mode collapses workspace-code hits to path references (no body)', () => {
    const out = renderFusedContext(
      [
        codeHit('gui_calculator.py', 'CalculatorApp', 'class CalculatorApp:\n    ...the stale body...'),
        codeHit('gui_calculator.py', 'on_click', 'def on_click(self): ...'),
      ],
      '## Ctx',
      'reference',
    );
    expect(out).not.toContain('stale body');
    expect(out).not.toContain('def on_click(self): ...');
    expect(out).toContain('`gui_calculator.py`');
    expect(out).toContain('CalculatorApp');
    expect(out).toContain('on_click'); // titles aggregated per file
    expect(out).toContain('read_file');
  });

  it('reference mode keeps non-code (doc/memory) hit content — those are not edited', () => {
    const out = renderFusedContext([docHit('doc:readme', 'Project overview text')], '## Ctx', 'reference');
    expect(out).toContain('Project overview text');
  });

  it('reference mode mixes code references and doc content', () => {
    const out = renderFusedContext(
      [codeHit('a.ts', 'foo', 'function foo(){STALE}'), docHit('doc:x', 'doc body')],
      '## Ctx',
      'reference',
    );
    expect(out).not.toContain('STALE');
    expect(out).toContain('`a.ts`');
    expect(out).toContain('doc body');
  });
});

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
