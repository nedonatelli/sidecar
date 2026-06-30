import { describe, it, expect } from 'vitest';
import { SymbolGraph, type SymbolEntry } from '../config/symbolGraph.js';
import { extractKernelShapes, checkShapeConsistency } from './shapePropagation.js';

describe('extractKernelShapes', () => {
  it('parses param annotations, return annotation, asserts, and tail calls', () => {
    const src = [
      'def f(a: NDArray[Shape["N, 3"]], b: np.ndarray) -> NDArray[Shape["3, N"]]:',
      '    assert a.shape == (N, 4)',
      '    assert b.dtype == np.float64',
      '    return rotate(a)',
    ].join('\n');
    const ks = extractKernelShapes(src);
    expect(ks.params.get('a')).toEqual({ dims: ['N', 3], dtype: undefined });
    expect(ks.params.has('b')).toBe(false); // bare np.ndarray → no spec
    expect(ks.returnSpec).toEqual({ dims: [3, 'N'], dtype: undefined });
    expect(ks.assertShapes.get('a')).toEqual({ dims: ['N', 4] });
    expect(ks.assertShapes.get('b')).toMatchObject({ dtype: 'np.float64' });
    expect(ks.tailReturnCallees).toEqual(['rotate']);
  });

  it('handles default values and starred params', () => {
    const ks = extractKernelShapes('def g(x: NDArray[Shape["3"]] = None, *args) -> None:\n    pass');
    expect(ks.params.get('x')).toEqual({ dims: [3], dtype: undefined });
  });
});

function fn(name: string, file: string, s: number, e: number): SymbolEntry {
  return { name, qualifiedName: name, type: 'function', filePath: file, startLine: s, endLine: e, exported: true };
}

describe('checkShapeConsistency — Rung A (intra-kernel)', () => {
  it('flags a param whose annotation and assertion disagree (literal dim)', () => {
    const src = ['def f(a: NDArray[Shape["N, 3"]]) -> None:', '    assert a.shape == (N, 4)', '    return None'].join(
      '\n',
    );
    const g = new SymbolGraph();
    g.addFile('k.py', [fn('f', 'k.py', 0, 2)], [], 'h1');
    g.setFileContent('k.py', src);
    const issues = checkShapeConsistency(g, () => src);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kernel: 'f', kind: 'intra-kernel', conflict: { kind: 'dim' } });
    expect(issues[0].detail).toContain('param `a`');
  });

  it('does not flag when annotation and assertion agree (symbolic compatible)', () => {
    const src = ['def f(a: NDArray[Shape["N, 3"]]) -> None:', '    assert a.shape == (5, 3)', '    return None'].join(
      '\n',
    );
    const g = new SymbolGraph();
    g.addFile('k.py', [fn('f', 'k.py', 0, 2)], [], 'h1');
    g.setFileContent('k.py', src);
    expect(checkShapeConsistency(g, () => src)).toEqual([]);
  });
});

describe('checkShapeConsistency — Rung B (tail-call returns)', () => {
  // f declares a rank-2 return but delegates to rotate, which returns rank-1.
  const fSrc = 'def f(x: np.ndarray) -> NDArray[Shape["N, 3"]]:\n    return rotate(x)';
  const gSrc = 'def rotate(x: np.ndarray) -> NDArray[Shape["3"]]:\n    return x[0]';

  function graph(): SymbolGraph {
    const g = new SymbolGraph();
    g.addFile('a.py', [fn('f', 'a.py', 0, 1)], [], 'h1');
    g.addFile('b.py', [fn('rotate', 'b.py', 0, 1)], [], 'h2');
    g.setFileContent('a.py', fSrc);
    g.setFileContent('b.py', gSrc);
    return g;
  }
  const read = (f: string) => (f === 'a.py' ? fSrc : f === 'b.py' ? gSrc : undefined);

  it('flags when f returns g() but their declared return shapes disagree', () => {
    const issues = checkShapeConsistency(graph(), read);
    const tail = issues.filter((i) => i.kind === 'tail-call');
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ kernel: 'f', conflict: { kind: 'rank' } });
    expect(tail[0].detail).toContain('rotate');
  });

  it('respects fileFilter for the caller but still resolves the callee cross-file', () => {
    const issues = checkShapeConsistency(graph(), read, { fileFilter: (f) => f === 'a.py' });
    expect(issues.filter((i) => i.kind === 'tail-call')).toHaveLength(1);
  });

  it('skips ambiguous same-name callees (no guessed conflict)', () => {
    const g = graph();
    // a second, different `rotate` makes resolution ambiguous.
    g.addFile('c.py', [fn('rotate', 'c.py', 0, 1)], [], 'h3');
    g.setFileContent('c.py', 'def rotate(x: np.ndarray) -> NDArray[Shape["N, 3"]]:\n    return x');
    const read2 = (f: string) =>
      f === 'a.py' ? fSrc : f === 'b.py' ? gSrc : f === 'c.py' ? 'def rotate(): pass' : undefined;
    expect(checkShapeConsistency(g, read2).filter((i) => i.kind === 'tail-call')).toEqual([]);
  });
});
