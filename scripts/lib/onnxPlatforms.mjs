// onnxruntime-node ships one native-binary directory per platform under
// bin/napi-v6/<os>/<arch>/, and its npm tarball bundles ALL of them. vsce
// packages whatever is on disk, so every per-target .vsix carried every
// platform's binaries -- ~150 MB uncompressed of files the target can never
// load -- and the linux-x64 install additionally downloads the 301 MB CUDA
// execution provider by default (its install metadata lists 'cuda12' for
// linux/x64), which made that .vsix 3x the others. SideCar runs its
// embeddings on CPU and never registers a GPU provider.
//
// Pure functions here; scripts/prune-onnxruntime-platforms.mjs applies them
// on the publish runner, and scripts/verify-package.mjs asserts the result.

export const ONNX_BIN = 'node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v6';

/** vsce --target name -> onnxruntime's <os>/<arch> directory. */
export function targetToPlatformDir(target) {
  const m = /^(darwin|linux|win32|alpine)-(x64|arm64)$/.exec(target);
  if (!m) throw new Error(`unknown vsce target "${target}" (expected e.g. linux-x64, darwin-arm64)`);
  return `${m[1] === 'alpine' ? 'linux' : m[1]}/${m[2]}`;
}

/**
 * GPU execution providers that a CPU-only consumer never loads. Excluded by
 * name rather than by size so a future large CPU-side file is not caught.
 */
export const GPU_PROVIDER_RE =
  /libonnxruntime_providers_(cuda|tensorrt)\.so$|onnxruntime_providers_(cuda|tensorrt)\.dll$/;

/**
 * Given the platform dirs present (e.g. ['darwin/arm64', 'linux/x64', ...])
 * and the target, the dirs to delete: every platform that is not the target.
 * Throws if the target's own dir is absent -- pruning would then leave the
 * package with no binary at all.
 */
export function planPrune(presentDirs, target) {
  const keep = targetToPlatformDir(target);
  if (!presentDirs.includes(keep)) {
    throw new Error(`onnxruntime binaries for ${target} (${keep}) are not present; refusing to prune the others`);
  }
  return presentDirs.filter((d) => d !== keep);
}

/**
 * Package-content check for a target: the file list must contain the target's
 * native binary and no other platform's directory. Returns a list of problems.
 */
export function checkPackagePlatforms(files, target) {
  const keep = targetToPlatformDir(target);
  const bin = (f) => f.replace(/\\/g, '/');
  const problems = [];
  const inBin = files.map(bin).filter((f) => f.includes('onnxruntime-node/bin/napi-v6/'));
  if (!inBin.some((f) => f.includes(`/napi-v6/${keep}/`)))
    problems.push(`no onnxruntime binary for ${target} (${keep})`);
  const others = new Set(inBin.map((f) => /napi-v6\/([^/]+\/[^/]+)\//.exec(f)?.[1]).filter((d) => d && d !== keep));
  if (others.size > 0)
    problems.push(`onnxruntime binaries for other platforms packaged: ${[...others].sort().join(', ')}`);
  return problems;
}
