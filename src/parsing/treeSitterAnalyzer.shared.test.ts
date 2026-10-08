import { describe, it, expect, vi } from 'vitest';
import { grammarsDir, hasGrammars } from './grammarsTestSupport.js';

// Loading a grammar while anything else uses the web-tree-sitter runtime
// corrupts it. A second analyzer, built by a second copy of the module (the
// extension bundle and the compiled sources the integration tests import),
// loaded grammars while the first was parsing, and every grammar failed.
// Every copy must get the one analyzer.

describe.skipIf(!hasGrammars)('createTreeSitterAnalyzer — two copies in one process', () => {
  it('returns the same analyzer to both, loaded once', async () => {
    vi.resetModules();
    const a = await import('./treeSitterAnalyzer.js');
    vi.resetModules();
    const b = await import('./treeSitterAnalyzer.js');
    expect(a).not.toBe(b);

    const [x, y] = await Promise.all([
      a.createTreeSitterAnalyzer(grammarsDir),
      b.createTreeSitterAnalyzer(grammarsDir),
    ]);
    expect(x).toBe(y);
    const uses = x.parseFileContent('t.py', 'def f(v: np.ndarray) -> None:\n    return None\n').typeUses ?? [];
    expect(uses.map((u) => u.typeName)).toContain('ndarray');
  });
});
