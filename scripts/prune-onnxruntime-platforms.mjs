#!/usr/bin/env node
// prune-onnxruntime-platforms.mjs — keep only ONE platform's onnxruntime
// binaries before `vsce package --target <target>`.
//
//   node scripts/prune-onnxruntime-platforms.mjs <target> [--dry-run]
//
// Run on the publish runner, after `npm ci` and before packaging. Each runner
// builds exactly one target, but onnxruntime-node's tarball bundles every
// platform's binaries and vsce packages what is on disk -- so every .vsix
// shipped ~150 MB (uncompressed) of binaries its platform can never load.
// See scripts/lib/onnxPlatforms.mjs. Deletion only; the CUDA provider is
// prevented earlier by ONNXRUNTIME_NODE_INSTALL=skip on `npm ci`, and
// scripts/verify-package.mjs <vsix> <target> asserts the packaged result.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ONNX_BIN, planPrune } from './lib/onnxPlatforms.mjs';

const target = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!target) {
  console.error('Usage: node scripts/prune-onnxruntime-platforms.mjs <vsce target> [--dry-run]');
  process.exit(1);
}
if (!existsSync(ONNX_BIN)) {
  console.error(`✖ ${ONNX_BIN} not found — was npm ci run?`);
  process.exit(1);
}

const present = [];
for (const os of readdirSync(ONNX_BIN, { withFileTypes: true })) {
  if (!os.isDirectory()) continue;
  for (const arch of readdirSync(join(ONNX_BIN, os.name), { withFileTypes: true })) {
    if (arch.isDirectory()) present.push(`${os.name}/${arch.name}`);
  }
}
const remove = planPrune(present, target);
console.log(`onnxruntime platforms present: ${present.join(', ')}`);
console.log(
  `keeping ${target} → removing ${remove.length ? remove.join(', ') : 'nothing'}${dryRun ? ' (dry run)' : ''}`,
);
for (const dir of remove) {
  if (!dryRun) rmSync(join(ONNX_BIN, dir), { recursive: true, force: true });
}
