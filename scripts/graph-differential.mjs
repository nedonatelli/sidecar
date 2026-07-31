#!/usr/bin/env node
// Differential test of SideCar's symbol graph against an INDEPENDENT extractor.
//
// Why: SideCar's code graph is a moat component with no external check. Nothing
// in the suite can tell you what it FAILS to see, because every test is written
// against the same extractor that produces the data. The first run of this
// found that the TypeScript analyzer emits no `variable` symbols at all — 223
// `export const` declarations invisible to find_references / analyze_impact /
// PKI retrieval, including SideCar's own tool registrations. That class of
// defect is only visible from outside.
//
// The reference extractor is graphify (tree-sitter, deterministic, no LLM):
//   python3 -m venv .graphify-venv && .graphify-venv/bin/pip install graphifyy
//   node scripts/graph-differential.mjs
//
// Exits non-zero when coverage regresses past the recorded baseline, so this
// can gate. Absent a reference graph it SKIPS rather than passes — a check that
// silently no-ops when its input is missing is the failure mode this repo has
// been burned by twice this week.

import { readFileSync, existsSync } from 'fs';
import path from 'path';

const REPO = process.cwd();
const SIDECAR_GRAPH = path.join(REPO, '.sidecar/cache/symbol-graph.json');
const REF_GRAPH = process.argv[2] ?? path.join(REPO, 'graphify-out/graph.json');

/** Files the reference extractor indexes that ours legitimately should not. */
const EXPECTED_MISSES = [
  /\/__corpus__\//, // deliberately malformed byte fixtures — not source
  /\.(md|json|txt)$/, // not code
];

if (!existsSync(SIDECAR_GRAPH)) {
  console.log(`SKIP: no symbol graph at ${SIDECAR_GRAPH} — open the workspace in VS Code once to build it.`);
  process.exit(0);
}
if (!existsSync(REF_GRAPH)) {
  console.log(`SKIP: no reference graph at ${REF_GRAPH}.`);
  console.log('  Build one:  <venv>/bin/graphify update ./src --no-cluster');
  console.log('  Then point this script at src/graphify-out/graph.json');
  console.log('  NOTE: graphify writes into the scanned directory; move it out of the repo afterwards.');
  process.exit(0);
}

const ours = JSON.parse(readFileSync(SIDECAR_GRAPH, 'utf-8'));
const ref = JSON.parse(readFileSync(REF_GRAPH, 'utf-8'));

// Ours stores workspace-relative paths (src/…); graphify's are relative to the
// directory it scanned (src), so strip the prefix to compare.
const ourFiles = new Set(
  ours.symbols.map((s) => s.filePath).filter((f) => f?.startsWith('src/')).map((f) => f.slice(4)),
);
const refFiles = new Set(ref.nodes.map((n) => n.source_file).filter(Boolean));

const missing = [...refFiles]
  .filter((f) => !ourFiles.has(f))
  .filter((f) => !EXPECTED_MISSES.some((re) => re.test(f)))
  .sort();

const byKind = ours.symbols.reduce((a, s) => ((a[s.type] = (a[s.type] ?? 0) + 1), a), {});
const barrels = missing.filter((f) => {
  try {
    const src = readFileSync(path.join(REPO, 'src', f), 'utf-8');
    const code = src.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    return code.length > 0 && code.every((l) => /^\s*(export\s+.*\bfrom\b|import\b)/.test(l));
  } catch {
    return false;
  }
});
// Test files whose bodies are entirely inline `describe`/`it` arrow callbacks
// have no named top-level symbols, so having none indexed is CORRECT. They are
// reported but not gated — SideCar does index 372 test files that do declare
// helpers, so a jump here would still be worth seeing.
const tests = missing.filter((f) => /\.test\.ts$/.test(f) && !barrels.includes(f));
const realMisses = missing.filter((f) => !barrels.includes(f) && !tests.includes(f));

console.log('=== symbol-graph differential ===');
console.log(`  reference : ${ref.nodes.length} nodes / ${(ref.links ?? []).length} edges over ${refFiles.size} files`);
console.log(`  ours      : ${ours.symbols.length} symbols over ${ourFiles.size} files`);
console.log(`  by kind   : ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (!byKind.variable) {
  console.log('  WARNING: zero `variable` symbols — exported consts are not being indexed.');
  console.log('           symbolIndexer accepts el.type === "variable"; the analyzer never emits it.');
}
console.log(
  `  files ours misses : ${realMisses.length} source (gated), ${tests.length} test, ` +
    `${barrels.length} re-export barrel (both informational)`,
);
for (const f of realMisses) console.log(`     - ${f}`);

const BASELINE = Number(process.env.GRAPH_DIFF_BASELINE ?? 7);
if (realMisses.length > BASELINE) {
  console.error(`\nFAIL: ${realMisses.length} files unindexed, baseline is ${BASELINE}.`);
  process.exit(1);
}
console.log(`\nOK: ${realMisses.length} unindexed files, at or under the ${BASELINE} baseline.`);
