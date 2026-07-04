#!/usr/bin/env node
// Smoke-check that a packaged .vsix (or the current package staging via `vsce ls`)
// actually contains the runtime dependencies SideCar loads at activation. Guards
// against the failure mode where `--no-dependencies` or an over-broad .vscodeignore
// ships an extension whose tree-sitter / embedding / vision features silently break.
//
// Usage:
//   node scripts/verify-package.mjs [path/to/extension.vsix]
// With no argument it inspects what `vsce ls` would package.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const vsixPath = process.argv[2];

/** Return the list of packaged file paths, from a built .vsix or from `vsce ls`. */
function listFiles() {
  if (vsixPath) {
    if (!existsSync(vsixPath)) {
      console.error(`✖ VSIX not found: ${vsixPath}`);
      process.exit(1);
    }
    // A .vsix is a zip. `vsce ls <vsix>` is not a thing, so read the archive.
    // `tar -tf` reads zip archives on macOS/Linux/Windows (bsdtar) runners.
    const out = execFileSync('tar', ['-tf', vsixPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').map((l) => l.replace(/^extension\//, ''));
  }
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const out = execFileSync(npx, ['@vscode/vsce', 'ls'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n');
}

const files = listFiles();
const has = (re) => files.some((f) => re.test(f));

const platform = process.platform; // 'darwin' | 'linux' | 'win32'
const hostSharp = new RegExp(`@img[/\\\\]sharp-${platform}-`);

const checks = [
  ['web-tree-sitter runtime', /web-tree-sitter[/\\]/],
  ['tree-sitter grammars', /grammars[/\\]tree-sitter-typescript\.wasm/],
  ['@huggingface/transformers dist', /@huggingface[/\\]transformers[/\\]dist[/\\]/],
  [`host sharp native binary (${platform})`, hostSharp],
  ['onnxruntime native binary', /onnxruntime-node[/\\]bin[/\\]napi-v6[/\\].+\.(node|dylib|so|dll)/],
];

const missing = checks.filter(([, re]) => !has(re)).map(([name]) => name);

if (missing.length > 0) {
  console.error('✖ VSIX smoke check FAILED — these runtime files are missing:');
  for (const name of missing) console.error(`    - ${name}`);
  console.error(
    '\nThe extension would install but its tree-sitter / embedding / vision features would break.\n' +
      'Likely cause: packaged with `--no-dependencies`, or a .vscodeignore that no longer re-includes these paths.',
  );
  process.exit(1);
}

console.log(`✓ VSIX smoke check passed — all runtime dependencies present (platform: ${platform}, files: ${files.length}).`);
