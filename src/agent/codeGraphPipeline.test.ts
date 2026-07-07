import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { grammarsDir, hasGrammars } from '../parsing/grammarsTestSupport.js';
import { setGrammarsPath, getAnalyzer } from '../parsing/registry.js';
import { SimpleCodeAnalyzer } from '../astContext.js';
import {
  SymbolGraph,
  type SymbolEntry,
  type ImportEdge,
  type CallEdge,
  type TypeEdge,
  type TypeUseEdge,
} from '../config/symbolGraph.js';
import { findNumericalKernels } from './numericalContracts.js';
import { checkShapeConsistency } from './shapePropagation.js';

// End-to-end: real tree-sitter extraction → graph (built exactly as
// SymbolIndexer.indexFile does) → the §5 analyzers + impact query. This is the
// seam the unit tests mock (they hand-build graph edges); here the edges come
// from the actual parser, proving extraction and analysis agree.

/** Mirror of SymbolIndexer.indexFile's parsed → graph mapping. */
async function indexSource(graph: SymbolGraph, rel: string, content: string): Promise<void> {
  const ext = path.extname(rel).slice(1).toLowerCase();
  const analyzer = await getAnalyzer(ext);
  const parsed = analyzer.parseFileContent(rel, content);

  const symbols: SymbolEntry[] = [];
  const imports: ImportEdge[] = [];
  for (const el of parsed.elements) {
    if (el.type === 'import') {
      const resolved = SimpleCodeAnalyzer.resolveImportPath(rel, el.name);
      if (resolved) imports.push({ fromFile: rel, toFile: resolved, importedNames: el.bindings || [] });
    } else if (['function', 'class', 'method', 'interface', 'type', 'enum', 'variable'].includes(el.type)) {
      symbols.push({
        name: el.name,
        qualifiedName: el.name,
        type: el.type as SymbolEntry['type'],
        filePath: rel,
        startLine: el.startLine,
        endLine: el.endLine,
        exported: el.exported ?? false,
      });
    }
  }
  const calls: CallEdge[] = (parsed.calls || []).map((c) => ({
    callerFile: rel,
    callerName: c.callerName,
    calleeName: c.calleeName,
    line: c.line,
  }));
  const typeEdges: TypeEdge[] = (parsed.typeRelations || []).map((r) => ({
    childFile: rel,
    childName: r.childName,
    parentName: r.parentName,
    kind: r.kind,
  }));
  const typeUses: TypeUseEdge[] = (parsed.typeUses || []).map((u) => ({
    userFile: rel,
    userName: u.userName,
    typeName: u.typeName,
    role: u.role,
    line: u.line,
  }));
  graph.addFile(rel, symbols, imports, '0:0', calls, typeEdges, typeUses);
  // NB: setFileContent MUST follow addFile — addFile→removeFile clears
  // fileContents, so the production set-before-add order leaves getFileContent
  // empty (callers read source from disk instead).
  graph.setFileContent(rel, content);
}

const GEOMETRY = [
  'import numpy as np',
  'from nptyping import NDArray, Shape',
  '',
  'def normalize(v: np.ndarray) -> np.ndarray:', // bare → uncontracted kernel
  '    return v / 2',
  '',
  'def producer(x: np.ndarray) -> NDArray[Shape["N, 3"]]:', // rank-2 return
  '    return x',
  '',
  'def consumer(p: NDArray[Shape["3"]]) -> None:', // expects rank-1
  '    return None',
  '',
  'def to_unit(p: NDArray[Shape["N, 3"]]) -> None:', // annotation rank-2…
  '    assert p.shape == (N, 4)', // …assertion says (N, 4): a dim conflict
  '    return None',
  '',
  'def pipeline(x: np.ndarray) -> None:',
  '    u = producer(x)', // u : (N, 3)
  '    consumer(u)', // passes (N, 3) where (3,) is expected → dataflow conflict
  '    normalize(x)',
].join('\n');

describe.skipIf(!hasGrammars)('code-graph pipeline (real tree-sitter → graph → analysis)', () => {
  let graph: SymbolGraph;
  beforeAll(async () => {
    setGrammarsPath(grammarsDir);
    graph = new SymbolGraph();
    await indexSource(graph, 'geometry.py', GEOMETRY);
  }, 30000);

  it('extracts type-use edges that locate numerical kernels', () => {
    // The real parser must have produced the ndarray/NDArray type-use edges.
    const users = new Set(graph.getTypeUsers('ndarray').map((u) => u.userName));
    expect(users.has('normalize')).toBe(true);
    expect(graph.getTypeUsers('NDArray').length).toBeGreaterThan(0);
  });

  it('flags the uncontracted bare-ndarray kernel', () => {
    const kernels = findNumericalKernels(graph, (f) => graph.getFileContent(f));
    const normalize = kernels.find((k) => k.name === 'normalize');
    expect(normalize).toBeTruthy();
    expect(normalize!.hasContract).toBe(false);
  });

  it('flags the intra-kernel and cross-call shape conflicts on real edges', () => {
    const issues = checkShapeConsistency(graph, (f) => graph.getFileContent(f));
    const kinds = issues.map((i) => `${i.kernel}:${i.kind}`);
    expect(kinds).toContain('to_unit:intra-kernel'); // (N,3) annotation vs (N,4) assert
    expect(kinds).toContain('pipeline:dataflow'); // producer→u→consumer rank mismatch
  });

  it('resolves real call edges for change-impact', () => {
    // producer is called by pipeline (a real call edge from the parser).
    const impact = graph.impactOf([{ name: 'producer', file: 'geometry.py' }]);
    expect(impact.some((i) => i.reason === 'calls' && i.name === 'pipeline')).toBe(true);
  });
});
