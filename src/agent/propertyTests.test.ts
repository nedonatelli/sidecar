import { describe, it, expect } from 'vitest';
import { parsePropertyDeclarations, parseParams, synthesizeHypothesisTest } from './propertyTests.js';

describe('parsePropertyDeclarations', () => {
  it('parses named properties from # property: comments', () => {
    const src = '# property: symmetric\n# property: idempotent\n# property: monotonic\n# property: non-negative';
    expect(parsePropertyDeclarations(src).map((p) => p.kind)).toEqual([
      'symmetric',
      'idempotent',
      'monotonic',
      'nonneg',
    ]);
  });

  it('treats a bound/invariant as a property (reuses analyticBounds)', () => {
    const src = '# bounds: 0 <= result <= 1\n# invariant: sum(result) == 1';
    const kinds = parsePropertyDeclarations(src).map((p) => p.kind);
    expect(kinds).toContain('bound');
    expect(kinds).toContain('conservation');
  });

  it('falls back to custom for a free-form property predicate', () => {
    const [p] = parsePropertyDeclarations('# property: np.allclose(result, result[::-1])');
    expect(p.kind).toBe('custom');
    expect(p.raw).toContain('np.allclose');
  });

  it('returns [] when nothing is declared', () => {
    expect(parsePropertyDeclarations('def f(x):\n    return x')).toEqual([]);
  });
});

describe('parseParams', () => {
  it('extracts positional params, dropping self and annotations/defaults', () => {
    expect(parseParams('def dist(self, a: np.ndarray, b: np.ndarray = None):', 'dist')).toEqual(['a', 'b']);
  });
  it('drops *args / **kwargs', () => {
    expect(parseParams('def f(x, *args, **kw):', 'f')).toEqual(['x']);
  });
  it('returns [] when the function is not found', () => {
    expect(parseParams('def other(x):', 'missing')).toEqual([]);
  });
});

describe('synthesizeHypothesisTest', () => {
  it('returns null when the kernel declares no properties', () => {
    expect(synthesizeHypothesisTest('f', 'def f(x):\n    return x + 1')).toBeNull();
  });

  it('emits a complete, runnable Hypothesis test for a bound', () => {
    const src = 'def prob(x):\n    # bounds: 0 <= result <= 1\n    return softmax(x)';
    const test = synthesizeHypothesisTest('prob', src, { module: 'src.model' });
    expect(test).toContain('from hypothesis import given, settings');
    expect(test).toContain('from hypothesis.extra.numpy import arrays, array_shapes');
    expect(test).toContain('from src.model import prob');
    expect(test).toContain('@given(');
    expect(test).toContain('def test_prob_properties(x):');
    expect(test).toContain('result = prob(x)');
    expect(test).toContain('np.all(result >= 0) and np.all(result <= 1)');
  });

  it('generates a symmetry check calling with swapped args', () => {
    const src = 'def kernel(a, b):\n    # property: symmetric\n    return a @ b';
    const test = synthesizeHypothesisTest('kernel', src)!;
    expect(test).toContain('def test_kernel_properties(a, b):');
    expect(test).toContain('np.allclose(result, kernel(b, a))');
  });

  it('generates an idempotence check f(f(x)) == f(x)', () => {
    const src = 'def normalize(x):\n    # property: idempotent\n    return x / np.linalg.norm(x)';
    const test = synthesizeHypothesisTest('normalize', src)!;
    expect(test).toContain('np.allclose(result, normalize(result))');
  });

  it('one @given strategy per parameter', () => {
    const src = 'def f(a, b, c):\n    # property: non-negative\n    return a';
    const test = synthesizeHypothesisTest('f', src)!;
    expect((test.match(/arrays\(np\.float64/g) || []).length).toBe(3);
  });

  it('emits a conservation assertion from the raw invariant', () => {
    const src = 'def redistribute(w):\n    # invariant: np.isclose(np.sum(result), np.sum(w))\n    return w';
    const test = synthesizeHypothesisTest('redistribute', src)!;
    expect(test).toContain('assert np.isclose(np.sum(result), np.sum(w))');
  });
});
