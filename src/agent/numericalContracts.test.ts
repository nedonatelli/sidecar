import { describe, it, expect } from 'vitest';
import { SymbolGraph, type SymbolEntry, type TypeUseEdge } from '../config/symbolGraph.js';
import { detectContract, findNumericalKernels, uncontractedKernels } from './numericalContracts.js';

const SOURCE = [
  'def orient(p: np.ndarray) -> np.ndarray:', // 0 — bare, uncontracted
  '    return p[::-1]', // 1
  '', // 2
  'def checked(p: np.ndarray) -> np.ndarray:', // 3 — assertion
  '    assert p.shape == (3,)', // 4
  '    return p', // 5
  '', // 6
  'def shaped(p: NDArray[Shape["3"]]) -> None:', // 7 — shaped-type
  '    return None', // 8
  '', // 9
  'def documented(p: np.ndarray) -> np.ndarray:', // 10 — docstring
  '    """Rotate. p: shape (3,) ndarray."""', // 11
  '    return p', // 12
].join('\n');

function fn(name: string, start: number, end: number): SymbolEntry {
  return {
    name,
    qualifiedName: name,
    type: 'function',
    filePath: 'kern.py',
    startLine: start,
    endLine: end,
    exported: true,
  };
}
function use(name: string, typeName: string, role: TypeUseEdge['role']): TypeUseEdge {
  return { userFile: 'kern.py', userName: name, typeName, role, line: 1 };
}

function buildGraph(): SymbolGraph {
  const g = new SymbolGraph();
  g.addFile(
    'kern.py',
    [fn('orient', 0, 1), fn('checked', 3, 5), fn('shaped', 7, 8), fn('documented', 10, 12)],
    [],
    'h1',
    [],
    [],
    [
      use('orient', 'ndarray', 'param'),
      use('orient', 'ndarray', 'return'),
      use('checked', 'ndarray', 'param'),
      use('shaped', 'NDArray', 'param'),
      use('documented', 'ndarray', 'param'),
      use('documented', 'ndarray', 'return'),
      // module-level annotated assignment — must be ignored.
      use('<module>', 'ndarray', 'variable'),
    ],
  );
  g.setFileContent('kern.py', SOURCE);
  return g;
}

describe('detectContract', () => {
  it('recognizes shaped-type, assertion, and docstring contracts; rejects bare ndarray', () => {
    expect(detectContract('def f(p: NDArray[Shape["3"]]): ...')).toBe('shaped-type');
    expect(detectContract('npt.NDArray[np.float64]')).toBe('shaped-type');
    expect(detectContract('    assert arr.shape == (3, 3)')).toBe('assertion');
    expect(detectContract('    np.testing.assert_allclose(a, b)')).toBe('assertion');
    expect(detectContract('"""returns shape (N, 3) array."""')).toBe('docstring');
    expect(detectContract('def f(p: np.ndarray) -> np.ndarray:\n    return p[::-1]')).toBeNull();
  });
});

describe('findNumericalKernels', () => {
  it('locates numerical kernels from type-use edges and classifies contracts', () => {
    const kernels = findNumericalKernels(buildGraph(), (f) => (f === 'kern.py' ? SOURCE : undefined));
    const byName = Object.fromEntries(kernels.map((k) => [k.name, k]));

    expect(Object.keys(byName).sort()).toEqual(['checked', 'documented', 'orient', 'shaped']);
    expect(byName.orient).toMatchObject({ hasContract: false, roles: ['param', 'return'] });
    expect(byName.checked).toMatchObject({ hasContract: true, contractKind: 'assertion' });
    expect(byName.shaped).toMatchObject({ hasContract: true, contractKind: 'shaped-type' });
    expect(byName.documented).toMatchObject({ hasContract: true, contractKind: 'docstring' });
    // 1-based reporting lines.
    expect(byName.orient.startLine).toBe(1);
  });

  it('ignores <module> pseudo-symbols and respects the file filter', () => {
    const kernels = findNumericalKernels(buildGraph(), () => SOURCE, { fileFilter: (f) => f === 'other.py' });
    expect(kernels).toEqual([]);
    const names = findNumericalKernels(buildGraph(), () => SOURCE).map((k) => k.name);
    expect(names).not.toContain('<module>');
  });

  it('uncontractedKernels returns only the actionable bare kernels', () => {
    const bare = uncontractedKernels(findNumericalKernels(buildGraph(), () => SOURCE));
    expect(bare.map((k) => k.name)).toEqual(['orient']);
  });

  it('treats kernels as uncontracted when source is unavailable (conservative)', () => {
    const kernels = findNumericalKernels(buildGraph(), () => undefined);
    expect(kernels.every((k) => !k.hasContract)).toBe(true);
  });
});
