import { describe, it, expect } from 'vitest';
import {
  parseBoundDeclarations,
  classifyBound,
  boundAssertion,
  boundEnforced,
  unenforcedBounds,
  findUnenforcedBoundsInFiles,
  type BoundDeclaration,
  type BoundGraph,
} from './analyticBounds.js';

describe('classifyBound', () => {
  it('two-sided range with numeric bounds', () => {
    const b = classifyBound('0 <= result <= 1');
    expect(b.kind).toBe('range');
    expect(b.lower).toBe(0);
    expect(b.upper).toBe(1);
  });

  it('negative range (reflection coefficient −1..1)', () => {
    const b = classifyBound('-1 <= result <= 1');
    expect(b).toMatchObject({ kind: 'range', lower: -1, upper: 1 });
  });

  it('non-negative sign (>= 0) vs strictly positive (> 0)', () => {
    expect(classifyBound('result >= 0').kind).toBe('sign-nonneg');
    expect(classifyBound('result > 0').kind).toBe('sign-pos');
  });

  it('lower bound with a nonzero constant', () => {
    expect(classifyBound('result >= 2.5')).toMatchObject({ kind: 'lower', lower: 2.5 });
  });

  it('upper bound only', () => {
    expect(classifyBound('result <= 1e3')).toMatchObject({ kind: 'upper', upper: 1000 });
  });

  it('conservation (sum invariant)', () => {
    expect(classifyBound('sum(result) == sum(x)').kind).toBe('conservation');
    expect(classifyBound('anything', true).kind).toBe('conservation');
  });

  it('falls back to custom for an unparseable predicate', () => {
    expect(classifyBound('result is monotonic').kind).toBe('custom');
  });
});

describe('parseBoundDeclarations', () => {
  it('parses a # bounds: comment', () => {
    const [b] = parseBoundDeclarations('def prob(x):\n    # bounds: 0 <= result <= 1\n    return x');
    expect(b).toMatchObject({ kind: 'range', lower: 0, upper: 1, where: 'comment', line: 2 });
  });

  it('parses a # invariant: comment as conservation', () => {
    const [b] = parseBoundDeclarations('# invariant: sum(result) == sum(w)');
    expect(b.kind).toBe('conservation');
    expect(b.where).toBe('comment');
  });

  it('parses a @bounds("…") decorator', () => {
    const [b] = parseBoundDeclarations('@bounds("result >= 0")\ndef energy(x): ...');
    expect(b).toMatchObject({ kind: 'sign-nonneg', where: 'decorator' });
  });

  it('parses a docstring Bounds: line', () => {
    const src = 'def f(x):\n    """Compute.\n    Bounds: result <= 1.0\n    """\n    return x';
    const [b] = parseBoundDeclarations(src);
    expect(b).toMatchObject({ kind: 'upper', upper: 1, where: 'docstring' });
  });

  it('returns [] when no bound is declared', () => {
    expect(parseBoundDeclarations('def f(x):\n    return x + 1')).toEqual([]);
  });

  it('parses multiple declarations in one kernel', () => {
    const src = '# bounds: result >= 0\n# invariant: sum(result) == 1';
    const kinds = parseBoundDeclarations(src).map((b) => b.kind);
    expect(kinds).toEqual(['sign-nonneg', 'conservation']);
  });
});

describe('boundAssertion — concrete, array-safe, never a stub', () => {
  const decl = (over: Partial<BoundDeclaration>): BoundDeclaration => ({
    kind: 'range',
    raw: '0 <= result <= 1',
    line: 1,
    resultVar: 'result',
    where: 'comment',
    ...over,
  });

  it('range → np.all on both sides', () => {
    expect(boundAssertion(decl({ lower: 0, upper: 1 }))).toContain('np.all(result >= 0) and np.all(result <= 1)');
  });
  it('sign-nonneg → np.all(result >= 0)', () => {
    expect(boundAssertion(decl({ kind: 'sign-nonneg', raw: 'result >= 0' }))).toContain('np.all(result >= 0)');
  });
  it('conservation → asserts the raw predicate', () => {
    expect(boundAssertion(decl({ kind: 'conservation', raw: 'sum(result) == sum(x)' }))).toContain(
      'assert sum(result) == sum(x)',
    );
  });
});

describe('boundEnforced', () => {
  const range: BoundDeclaration = {
    kind: 'range',
    raw: '0 <= result <= 1',
    line: 1,
    lower: 0,
    upper: 1,
    resultVar: 'result',
    where: 'comment',
  };

  it('true when an assert on the result is present', () => {
    expect(
      boundEnforced('result = f(x)\nassert np.all(result >= 0) and np.all(result <= 1)\nreturn result', range),
    ).toBe(true);
  });
  it('true when the result is clipped', () => {
    expect(boundEnforced('result = np.clip(f(x), 0, 1)\nreturn result', range)).toBe(true);
  });
  it('true when a raise guards it', () => {
    expect(boundEnforced('if (result < 0).any():\n    raise ValueError("neg")', range)).toBe(true);
  });
  it('false when nothing enforces it', () => {
    expect(boundEnforced('result = softmax(x)\nreturn result', range)).toBe(false);
  });
  it('false when the only assert does not touch the result', () => {
    expect(boundEnforced('assert x.shape == (3,)\nresult = f(x)\nreturn result', range)).toBe(false);
  });
});

describe('unenforcedBounds', () => {
  it('flags a declared-but-unenforced bound with the concrete fix', () => {
    const body = 'def prob(x):\n    # bounds: 0 <= result <= 1\n    result = softmax(x)\n    return result';
    const findings = unenforcedBounds(body);
    expect(findings).toHaveLength(1);
    expect(findings[0].bound.kind).toBe('range');
    expect(findings[0].fix).toContain('np.all(result >= 0) and np.all(result <= 1)');
  });

  it('passes a kernel that declares AND enforces its bound', () => {
    const body =
      'def prob(x):\n    # bounds: 0 <= result <= 1\n    result = np.clip(softmax(x), 0, 1)\n    return result';
    expect(unenforcedBounds(body)).toEqual([]);
  });

  it('no declaration → nothing to flag', () => {
    expect(unenforcedBounds('def f(x):\n    return x * 2')).toEqual([]);
  });
});

describe('findUnenforcedBoundsInFiles', () => {
  // File: two functions. `prob` declares a bound but doesn't enforce it (gap);
  // `energy` declares AND clips (clean). A guard in `energy` must NOT excuse
  // `prob` — that's why slicing is per-function.
  const FILE = [
    'def prob(x):', //                       line 1  (sym startLine 0)
    '    # bounds: 0 <= result <= 1', //     line 2
    '    result = softmax(x)', //            line 3
    '    return result', //                  line 4
    '', //                                   line 5
    'def energy(x):', //                     line 6  (sym startLine 5)
    '    # bounds: result >= 0', //          line 7
    '    result = np.clip(dot(x, x), 0, None)', // line 8
    '    return result', //                  line 9
  ].join('\n');

  const graph: BoundGraph = {
    getSymbolsInFile: () => [
      { name: 'prob', startLine: 0, endLine: 3 },
      { name: 'energy', startLine: 5, endLine: 8 },
    ],
  };

  it('flags the unenforced kernel, passes the enforced one, with file-absolute lines', () => {
    const findings = findUnenforcedBoundsInFiles(['m.py'], graph, () => FILE);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ func: 'prob', file: 'm.py', fileLine: 2 });
    expect(findings[0].bound.kind).toBe('range');
    expect(findings[0].fix).toContain('np.all(result >= 0) and np.all(result <= 1)');
  });

  it('skips files the reader can’t load', () => {
    expect(findUnenforcedBoundsInFiles(['missing.py'], graph, () => undefined)).toEqual([]);
  });
});
