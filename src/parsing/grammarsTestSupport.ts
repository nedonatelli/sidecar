import * as path from 'path';
import * as fs from 'fs';

/**
 * Shared support for the real-grammar tree-sitter test suites.
 *
 * The wasm grammars live in the gitignored `grammars/` build artifact, created
 * by `npm run copy-grammars` (also part of `npm run build`). Suites `skipIf`
 * they are absent so a grammar-less checkout doesn't fail — but in CI that skip
 * is dangerous: it would report green while covering none of the tree-sitter
 * analyzer, which underpins the symbol graph, PKI, and impact analysis.
 */

/** Directory holding the tree-sitter wasm grammars. */
export const grammarsDir = path.join(process.cwd(), 'grammars');

/** True when the wasm grammars have been built into `grammars/`. */
export const hasGrammars =
  fs.existsSync(path.join(grammarsDir, 'tree-sitter-typescript.wasm')) &&
  fs.existsSync(path.join(grammarsDir, 'tree-sitter-python.wasm'));

// Loud guard: in CI the grammars MUST be present. If a workflow forgets the
// `npm run copy-grammars` step, fail here instead of silently skipping the
// real-grammar suites and reporting a green build that verified nothing.
if (process.env.CI && !hasGrammars) {
  throw new Error(
    'Tree-sitter grammars are missing under grammars/ while running in CI. ' +
      'Add a `npm run copy-grammars` step before the test step in the workflow ' +
      '(.github/workflows/ci.yml, publish.yml). The real-grammar suites must not silently skip in CI.',
  );
}
