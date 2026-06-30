import { describe, it, expect, afterEach } from 'vitest';
import { analyzeImpact } from './impact.js';
import { setSymbolGraph } from './runtime.js';
import { SymbolGraph } from '../../config/symbolGraph.js';

function buildGraph(): SymbolGraph {
  const g = new SymbolGraph();
  // src/auth.ts defines requireAuth (exported); src/route.ts calls it + uses AuthConfig as a param type.
  g.addFile(
    'src/auth.ts',
    [
      {
        name: 'requireAuth',
        qualifiedName: 'requireAuth',
        type: 'function',
        filePath: 'src/auth.ts',
        startLine: 0,
        endLine: 4,
        exported: true,
      },
      {
        name: 'AuthConfig',
        qualifiedName: 'AuthConfig',
        type: 'interface',
        filePath: 'src/auth.ts',
        startLine: 6,
        endLine: 8,
        exported: true,
      },
    ],
    [],
    'h1',
  );
  g.addFile(
    'src/route.ts',
    [
      {
        name: 'handleLogin',
        qualifiedName: 'handleLogin',
        type: 'function',
        filePath: 'src/route.ts',
        startLine: 0,
        endLine: 6,
        exported: true,
      },
    ],
    [{ fromFile: 'src/route.ts', toFile: 'src/auth', importedNames: ['requireAuth', 'AuthConfig'] }],
    'h2',
    [{ callerFile: 'src/route.ts', callerName: 'handleLogin', calleeName: 'requireAuth', line: 3 }],
    [],
    [{ userFile: 'src/route.ts', userName: 'handleLogin', typeName: 'AuthConfig', role: 'param', line: 1 }],
  );
  return g;
}

describe('analyze_impact tool', () => {
  afterEach(() => setSymbolGraph(null));

  it('reports callers, type users, and importers for a changed symbol', async () => {
    setSymbolGraph(buildGraph());
    const out = await analyzeImpact({ symbols: ['requireAuth', 'AuthConfig'] });
    expect(out).toContain('Callers');
    expect(out).toContain('handleLogin');
    expect(out).toContain('calls requireAuth');
    expect(out).toContain('Type users');
    expect(out).toContain('param typed AuthConfig');
    expect(out).toContain('Importers');
  });

  it('analyzes every symbol defined in a file when given `file`', async () => {
    setSymbolGraph(buildGraph());
    const out = await analyzeImpact({ file: 'src/auth.ts' });
    expect(out).toContain('src/auth.ts (2 symbols)');
    expect(out).toContain('handleLogin');
  });

  it('returns a clear message when nothing depends on the symbol', async () => {
    setSymbolGraph(buildGraph());
    const out = await analyzeImpact({ symbols: ['handleLogin'] });
    expect(out).toContain('No downstream impact');
  });

  it('errors when neither symbols nor file is provided', async () => {
    setSymbolGraph(buildGraph());
    const out = await analyzeImpact({});
    expect(out).toContain('provide `symbols`');
  });

  it('reports graph-unavailable when no graph is wired', async () => {
    setSymbolGraph(null);
    const out = await analyzeImpact({ symbols: ['requireAuth'] });
    expect(out).toContain('Symbol graph not available');
  });
});
