import { describe, it, expect } from 'vitest';
import { buildImpactAdvisory } from './completionGates/codeGraphGates.js';
import { SymbolGraph } from '../../config/symbolGraph.js';

function graphWithDependents(): SymbolGraph {
  const g = new SymbolGraph();
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
        name: 'internalHelper',
        qualifiedName: 'internalHelper',
        type: 'function',
        filePath: 'src/auth.ts',
        startLine: 5,
        endLine: 7,
        exported: false,
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
    [{ fromFile: 'src/route.ts', toFile: 'src/auth', importedNames: ['requireAuth'] }],
    'h2',
    [{ callerFile: 'src/route.ts', callerName: 'handleLogin', calleeName: 'requireAuth', line: 3 }],
  );
  return g;
}

describe('buildImpactAdvisory', () => {
  it('summarizes cross-file dependents of edited exported symbols', () => {
    const advisory = buildImpactAdvisory(graphWithDependents(), new Set(['src/auth.ts']), '');
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('requireAuth');
    expect(advisory).toContain('caller'); // handleLogin calls it
    expect(advisory).toContain('importer'); // route.ts imports it
    expect(advisory).toContain('advisory');
    // Non-exported symbols are never listed.
    expect(advisory).not.toContain('internalHelper');
  });

  it('returns null when nothing external depends on the edited symbols', () => {
    // Editing the file that owns the dependents (route.ts) — handleLogin has no callers.
    const advisory = buildImpactAdvisory(graphWithDependents(), new Set(['src/route.ts']), '');
    expect(advisory).toBeNull();
  });

  it('relativizes absolute edited paths against the root', () => {
    const advisory = buildImpactAdvisory(graphWithDependents(), new Set(['/work/src/auth.ts']), '/work');
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('requireAuth');
  });
});
