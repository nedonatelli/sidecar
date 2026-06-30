import { describe, it, expect, afterEach } from 'vitest';
import { checkShapeConsistencyTool } from './shapeConsistency.js';
import { setSymbolGraph } from './runtime.js';
import { SymbolGraph, type SymbolEntry } from '../../config/symbolGraph.js';

function fn(name: string, s: number, e: number): SymbolEntry {
  return { name, qualifiedName: name, type: 'function', filePath: 'geo.py', startLine: s, endLine: e, exported: true };
}

describe('check_shape_consistency tool', () => {
  afterEach(() => setSymbolGraph(null));

  it('reports an intra-kernel conflict', async () => {
    const g = new SymbolGraph();
    g.addFile('geo.py', [fn('f', 0, 2)], [], 'h1');
    g.setFileContent(
      'geo.py',
      ['def f(a: NDArray[Shape["N, 3"]]) -> None:', '    assert a.shape == (N, 4)', '    return None'].join('\n'),
    );
    setSymbolGraph(g);
    const out = await checkShapeConsistencyTool({ file: 'geo.py' });
    expect(out).toContain('1 shape-contract conflict');
    expect(out).toMatch(/⚠ f .*\[intra-kernel\]/);
  });

  it('reports clean when contracts agree', async () => {
    const g = new SymbolGraph();
    g.addFile('geo.py', [fn('f', 0, 2)], [], 'h1');
    g.setFileContent(
      'geo.py',
      ['def f(a: NDArray[Shape["N, 3"]]) -> None:', '    assert a.shape == (5, 3)', '    return None'].join('\n'),
    );
    setSymbolGraph(g);
    expect(await checkShapeConsistencyTool({ file: 'geo.py' })).toContain('No shape-contract conflicts');
  });

  it('reports graph-unavailable when no graph is wired', async () => {
    setSymbolGraph(null);
    expect(await checkShapeConsistencyTool({})).toContain('Symbol graph not available');
  });
});
