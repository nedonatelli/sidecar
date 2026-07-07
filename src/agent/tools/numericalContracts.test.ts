import { describe, it, expect, afterEach } from 'vitest';
import { checkNumericalContracts } from './numericalContracts.js';
import { setSymbolGraph } from './runtime.js';
import { SymbolGraph, type SymbolEntry, type TypeUseEdge } from '../../config/symbolGraph.js';

const SRC = [
  'def orient(p: np.ndarray) -> np.ndarray:',
  '    return p[::-1]',
  '',
  'def checked(p: np.ndarray) -> np.ndarray:',
  '    assert p.shape == (3,)',
  '    return p',
].join('\n');

function fn(name: string, s: number, e: number): SymbolEntry {
  return { name, qualifiedName: name, type: 'function', filePath: 'geo.py', startLine: s, endLine: e, exported: true };
}
function use(name: string, role: TypeUseEdge['role']): TypeUseEdge {
  return { userFile: 'geo.py', userName: name, typeName: 'ndarray', role, line: 1 };
}

function graph(): SymbolGraph {
  const g = new SymbolGraph();
  g.addFile(
    'geo.py',
    [fn('orient', 0, 1), fn('checked', 3, 5)],
    [],
    'h1',
    [],
    [],
    [use('orient', 'param'), use('orient', 'return'), use('checked', 'param')],
  );
  g.setFileContent('geo.py', SRC);
  return g;
}

describe('check_numerical_contracts tool', () => {
  afterEach(() => setSymbolGraph(null));

  it('lists kernels and flags the uncontracted one', async () => {
    setSymbolGraph(graph());
    const out = await checkNumericalContracts({ file: 'geo.py' });
    expect(out).toContain('2 numerical kernels in geo.py — 1 missing');
    expect(out).toMatch(/⚠ orient .* no contract/);
    expect(out).toMatch(/✓ checked .* shape\/dtype assertion/);
  });

  it('onlyUncontracted hides contracted kernels', async () => {
    setSymbolGraph(graph());
    const out = await checkNumericalContracts({ file: 'geo.py', onlyUncontracted: true });
    expect(out).toContain('orient');
    expect(out).not.toMatch(/✓ checked/);
  });

  it('reports cleanly when a file has no numerical kernels', async () => {
    const g = new SymbolGraph();
    g.addFile('plain.py', [fn('f', 0, 1)], [], 'h1');
    setSymbolGraph(g);
    const out = await checkNumericalContracts({ file: 'plain.py' });
    expect(out).toContain('No numerical kernels found');
  });

  it('reports graph-unavailable when no graph is wired', async () => {
    setSymbolGraph(null);
    expect(await checkNumericalContracts({})).toContain('Symbol graph not available');
  });
});
