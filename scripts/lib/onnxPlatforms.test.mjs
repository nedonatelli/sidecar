import { describe, it, expect } from 'vitest';
import { targetToPlatformDir, planPrune, checkPackagePlatforms, GPU_PROVIDER_RE } from './onnxPlatforms.mjs';

// The v0.124.0 linux-x64 .vsix was 307 MB against ~103 MB for the other three
// targets: onnxruntime-node's default install downloads a 301 MB CUDA provider
// on linux/x64, and every target additionally carried every other platform's
// binaries. These pin the mapping, the prune plan, and the package check that
// would have failed that artifact.

const ALL = ['darwin/arm64', 'linux/arm64', 'linux/x64', 'win32/arm64', 'win32/x64'];

describe('targetToPlatformDir', () => {
  it('maps every publish target to its onnxruntime directory', () => {
    expect(targetToPlatformDir('darwin-arm64')).toBe('darwin/arm64');
    expect(targetToPlatformDir('linux-x64')).toBe('linux/x64');
    expect(targetToPlatformDir('linux-arm64')).toBe('linux/arm64');
    expect(targetToPlatformDir('win32-x64')).toBe('win32/x64');
    expect(targetToPlatformDir('alpine-x64')).toBe('linux/x64'); // onnxruntime has no alpine build dir
    expect(() => targetToPlatformDir('web')).toThrow(/unknown vsce target/);
  });
});

describe('planPrune', () => {
  it('removes every platform except the target', () => {
    expect(planPrune(ALL, 'linux-x64').sort()).toEqual(['darwin/arm64', 'linux/arm64', 'win32/arm64', 'win32/x64']);
  });
  it('refuses when the target itself is missing — pruning would leave no binary', () => {
    expect(() => planPrune(['darwin/arm64'], 'linux-x64')).toThrow(/not present; refusing/);
  });
});

describe('checkPackagePlatforms', () => {
  const bin = (d, f) =>
    `extension/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v6/${d}/${f}`;

  it('fails the shipped v0.124.0 shape: other platforms present', () => {
    const files = ALL.map((d) => bin(d, 'onnxruntime_binding.node'));
    const problems = checkPackagePlatforms(files, 'linux-x64');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/other platforms packaged: darwin\/arm64, linux\/arm64, win32\/arm64, win32\/x64/);
  });

  it('passes a pruned package: only the target directory, with a binary', () => {
    const files = [
      bin('linux/x64', 'libonnxruntime.so.1'),
      bin('linux/x64', 'onnxruntime_binding.node'),
      'extension/dist/extension.js',
    ];
    expect(checkPackagePlatforms(files, 'linux-x64')).toEqual([]);
  });

  it('fails when the target has no binary at all', () => {
    expect(checkPackagePlatforms(['extension/dist/extension.js'], 'win32-x64')[0]).toMatch(
      /no onnxruntime binary for win32-x64/,
    );
  });

  it('accepts Windows-style separators in the listing', () => {
    const files = [bin('win32/x64', 'onnxruntime.dll').replace(/\//g, '\\')];
    expect(checkPackagePlatforms(files, 'win32-x64')).toEqual([]);
  });
});

describe('GPU_PROVIDER_RE', () => {
  it('names the CUDA/TensorRT providers and nothing else', () => {
    expect(GPU_PROVIDER_RE.test('bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so')).toBe(true);
    expect(GPU_PROVIDER_RE.test('bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so')).toBe(true);
    expect(GPU_PROVIDER_RE.test('bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so')).toBe(false);
    expect(GPU_PROVIDER_RE.test('bin/napi-v6/linux/x64/libonnxruntime.so.1')).toBe(false);
  });
});
