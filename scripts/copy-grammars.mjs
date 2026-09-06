#!/usr/bin/env node
// Copy the tree-sitter WASM grammars into grammars/.
//
// Was an npm script: `mkdir -p grammars && cp <20 paths> grammars/`. npm runs
// scripts through cmd.exe on Windows, where `mkdir -p` creates a directory
// literally named "-p" and `cp` does not exist at all -- so `npm run
// copy-grammars` failed, and with it every real-grammar tree-sitter suite,
// which skipIf grammars/ is absent. The suites did not fail on Windows; they
// silently did not run.
//
// Node's fs is the portable answer: no shell, no platform-specific path
// separators, and a missing source is a loud error rather than a partial copy.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'grammars');

const LANGUAGES = [
  'typescript', 'tsx', 'javascript', 'python', 'rust', 'go', 'java', 'kotlin',
  'c_sharp', 'ruby', 'swift', 'c', 'cpp', 'bash', 'php', 'lua', 'scala', 'dart', 'vue',
];

const sources = [
  join(root, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm'),
  ...LANGUAGES.map((l) => join(root, 'node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${l}.wasm`)),
];

mkdirSync(out, { recursive: true });

const missing = sources.filter((s) => !existsSync(s));
if (missing.length > 0) {
  console.error(`copy-grammars: ${missing.length} source file(s) missing — did npm ci run?`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}

for (const src of sources) copyFileSync(src, join(out, basename(src)));
console.log(`copy-grammars: copied ${sources.length} grammars to ${out}`);
