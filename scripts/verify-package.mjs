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
import { existsSync, readFileSync } from 'node:fs';

const vsixPath = process.argv[2];

/**
 * List the file names inside a .vsix (a ZIP) by reading its central directory
 * natively — no external `tar`/`unzip`. `tar -tf` only reads ZIPs with bsdtar
 * (macOS/Windows runners); GNU tar on the Linux runners rejects it ("not a tar
 * archive"), which silently broke the linux-x64 / linux-arm64 publish legs.
 */
function listZipEntries(path) {
  const buf = readFileSync(path);
  // End of Central Directory record: signature 0x06054b50, within the last
  // ~64KB (max comment length). Scan backwards for it.
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${path} is not a valid ZIP (no end-of-central-directory record)`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset
  const names = [];
  const CDH_SIG = 0x02014b50; // central directory file header
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CDH_SIG) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Return the list of packaged file paths, from a built .vsix or from `vsce ls`. */
function listFiles() {
  if (vsixPath) {
    if (!existsSync(vsixPath)) {
      console.error(`✖ VSIX not found: ${vsixPath}`);
      process.exit(1);
    }
    return listZipEntries(vsixPath).map((l) => l.replace(/^extension\//, ''));
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

// Deny-list: content that must NEVER ship in a public .vsix. `internal/` is
// the gitignored private-docs directory (strategy notes, dogfood plans) —
// v0.116.0 shipped it because nothing gated on it; this check makes that
// class of leak fail the release instead of passing the smoke check.
const forbidden = [
  ['internal/ private docs', /^internal[/\\]/],
  ['.sidecar/ workspace state', /^\.sidecar[/\\]/],
  ['.env files', /^\.env($|\.)/],
];
const leaked = forbidden
  .map(([name, re]) => [name, files.filter((f) => re.test(f))])
  .filter(([, hits]) => hits.length > 0);

if (leaked.length > 0) {
  console.error('✖ VSIX deny-list check FAILED — private content is packaged:');
  for (const [name, hits] of leaked) {
    console.error(`    - ${name}: ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` (+${hits.length - 5} more)` : ''}`);
  }
  console.error('\nAdd the path to .vscodeignore and repackage.');
  process.exit(1);
}

console.log(
  `✓ VSIX smoke check passed — all runtime dependencies present (platform: ${platform}, files: ${files.length}).`,
);
