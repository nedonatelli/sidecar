/**
 * Live in-host verification of the code-graph + §5 features: index a real file
 * with the production SymbolIndexer (real workspace APIs + real tree-sitter from
 * the bundled grammars), then run the actual tool executors and assert findings.
 * This is the end-to-end path the unit/pipeline tests can't reach.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { SymbolIndexer } from '../../config/symbolIndexer.js';
import { setGrammarsPath } from '../../parsing/registry.js';
import { setSymbolGraph } from '../../agent/tools/runtime.js';
import { checkNumericalContracts } from '../../agent/tools/numericalContracts.js';
import { checkShapeConsistencyTool } from '../../agent/tools/shapeConsistency.js';
import { analyzeImpact } from '../../agent/tools/impact.js';

const PY = [
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
  'def pipeline(x: np.ndarray) -> None:',
  '    u = producer(x)', // u : (N, 3)
  '    consumer(u)', // (N, 3) where (3,) expected → dataflow conflict
  '',
].join('\n');

suite('Code Graph + Numerical Contracts (live)', () => {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const rel = '.itest-tmp/geo_live.py';
  const abs = path.join(root, rel);

  let graph: import('../../config/symbolGraph.js').SymbolGraph;
  let tsDiag = 'not attempted';

  suiteSetup(async function () {
    this.timeout(60000);
    const ext =
      vscode.extensions.getExtension('nedonatelli.sidecar-ai') ??
      vscode.extensions.all.find((e) => e.id.toLowerCase().includes('sidecar'));
    if (ext && !ext.isActive) await ext.activate();
    setGrammarsPath(path.join(root, 'grammars'));

    // Diagnose tree-sitter directly: does web-tree-sitter load + produce edges
    // in the electron extension host?
    try {
      const mod = await import('../../parsing/treeSitterAnalyzer.js');
      const a = await mod.createTreeSitterAnalyzer(path.join(root, 'grammars'));
      const parsed = a.parseFileContent('t.py', 'def f(v: np.ndarray) -> np.ndarray:\n    return v');
      const users = (parsed.typeUses ?? []).map((u) => u.typeName);
      tsDiag = `loaded; py typeUses=[${users.join(',')}]`;
    } catch (e) {
      tsDiag = `LOAD FAILED: ${e instanceof Error ? e.message : String(e)}`;
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, PY);

    const indexer = new SymbolIndexer(null);
    await indexer.updateFile(rel);
    graph = indexer.getGraph();
    setSymbolGraph(graph);
  });

  suiteTeardown(() => {
    setSymbolGraph(null);
    try {
      fs.rmSync(path.dirname(abs), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  test('the production indexer used tree-sitter (np.ndarray type-flow edges present)', () => {
    // Regex extraction misses lowercase `np.ndarray` and emits no Python call
    // edges; tree-sitter captures both. Non-empty ndarray users + a producer
    // caller prove tree-sitter ran through the real indexer.
    const ndarrayUsers = new Set(graph.getTypeUsers('ndarray').map((u) => u.userName));
    assert.ok(ndarrayUsers.has('normalize'), `tree-sitter diag => ${tsDiag}; ndarray users=[${[...ndarrayUsers]}]`);
    assert.ok(
      graph.getCallers('producer').some((c) => c.callerName === 'pipeline'),
      'expected a real Python call edge',
    );
  });

  test('check_numerical_contracts flags the bare-ndarray kernel', async () => {
    const out = await checkNumericalContracts({ file: rel });
    assert.ok(/normalize/.test(out), `expected normalize in: ${out}`);
    assert.ok(/no contract/.test(out), `expected an uncontracted flag in: ${out}`);
  });

  test('check_shape_consistency flags the cross-call dataflow conflict', async () => {
    const out = await checkShapeConsistencyTool({ file: rel });
    assert.ok(/pipeline/.test(out), `expected pipeline conflict in: ${out}`);
    assert.ok(/dataflow/.test(out), `expected a dataflow conflict in: ${out}`);
  });

  test('analyze_impact resolves real call edges', async () => {
    const out = await analyzeImpact({ symbols: ['producer'] });
    assert.ok(/pipeline/.test(out), `expected pipeline as a caller of producer in: ${out}`);
  });
});
