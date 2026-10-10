import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SymbolIndexer } from '../../config/symbolIndexer.js';
import { setGrammarsPath } from '../../parsing/registry.js';

// The bash grammar's scanner calls isalpha, which web-tree-sitter 0.24's
// runtime does not export. A `case` statement threw mid-parse, left the shared
// runtime corrupt, and every later parse in every language failed; indexing
// this repo silently dropped 21-102 of 3,449 files. Index a directory of shell
// scripts mixed with Python and TypeScript, in the real host, and require every
// file to make it into the graph -- with its symbols.

const DIR = '.itest-shell';
const SHELLS = 30;
const PYS = 10;
const TSS = 5;

const shell = (i: number) =>
  [
    '#!/bin/bash',
    `usage_${i}() { echo "usage"; }`,
    'case "$1" in',
    `  -h|--help) usage_${i} ;;`,
    '  *) echo "unknown: $1" ;;',
    'esac',
    '',
  ].join('\n');
const python = (i: number) => `import numpy as np\n\ndef kernel_${i}(v: np.ndarray) -> np.ndarray:\n    return v * 2\n`;
const ts = (i: number) => `export function helper${i}(x: number): number {\n  return x + ${i};\n}\n`;

suite('Indexing a workspace with shell scripts (real host)', () => {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const abs = path.join(root, DIR);

  suiteSetup(() => {
    setGrammarsPath(path.join(root, 'grammars'));
    fs.rmSync(abs, { recursive: true, force: true });
    fs.mkdirSync(abs, { recursive: true });
    // Shell scripts first in name order, so a corrupting parse would come early.
    for (let i = 0; i < SHELLS; i++) fs.writeFileSync(path.join(abs, `a_run${i}.sh`), shell(i));
    for (let i = 0; i < PYS; i++) fs.writeFileSync(path.join(abs, `b_kernel${i}.py`), python(i));
    for (let i = 0; i < TSS; i++) fs.writeFileSync(path.join(abs, `c_helper${i}.ts`), ts(i));
  });

  suiteTeardown(() => {
    // Best effort: a busy extension host can still hold a file (EPERM on
    // Windows), and a failed cleanup must not read as a failed check. The
    // directory is gitignored (.itest-*/) and recreated by the next run.
    try {
      fs.rmSync(abs, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`could not remove ${DIR}: ${(err as Error).message}`);
    }
  });

  test('every file is indexed, and Python and TypeScript symbols survive the shell scripts', async function () {
    this.timeout(180_000);
    const indexer = new SymbolIndexer(null);
    try {
      await indexer.initialize([`${DIR}/**/*.sh`, `${DIR}/**/*.py`, `${DIR}/**/*.ts`]);
      const graph = indexer.getGraph();
      const indexed = [...graph.indexedFilePaths()].filter((p) => p.startsWith(`${DIR}/`));
      assert.strictEqual(
        indexed.length,
        SHELLS + PYS + TSS,
        `indexed ${indexed.length} of ${SHELLS + PYS + TSS}; missing: ${
          [...Array(SHELLS).keys()]
            .map((i) => `${DIR}/a_run${i}.sh`)
            .concat([...Array(PYS).keys()].map((i) => `${DIR}/b_kernel${i}.py`))
            .concat([...Array(TSS).keys()].map((i) => `${DIR}/c_helper${i}.ts`))
            .filter((p) => !indexed.includes(p))
            .slice(0, 10)
            .join(', ') || 'none'
        }`,
      );
      // Tree-sitter, not a fallback, still parses Python after the shell files:
      // the lowercase np.ndarray type use is something only the AST captures.
      const ndarrayUsers = new Set(graph.getTypeUsers('ndarray').map((u) => u.userName));
      for (let i = 0; i < PYS; i++) assert.ok(ndarrayUsers.has(`kernel_${i}`), `kernel_${i} lost its ndarray type use`);
    } finally {
      indexer.dispose();
    }
  });
});
