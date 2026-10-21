import { describe, it, expect } from 'vitest';
import { resolveEnvelopeRun, type SweRunManifest } from './report.js';

const anthropicRun: SweRunManifest = {
  model: 'claude-haiku-4-5-20251001',
  backend: 'anthropic',
  maxIterations: 50,
  scaffoldVersion: '5.1.0',
};

describe('resolveEnvelopeRun', () => {
  it('reports what the manifest recorded, not the env defaults', () => {
    expect(resolveEnvelopeRun(anthropicRun, {}, '9.9.9')).toEqual({
      model: 'claude-haiku-4-5-20251001',
      backend: 'anthropic',
      maxIterations: 50,
      scaffoldVersion: '5.1.0',
      quantization: undefined,
    });
  });

  it('lets the manifest win over conflicting env vars', () => {
    const env = { SIDECAR_SWE_MODEL: 'gemma4:e4b', SIDECAR_SWE_MAX_ITERS: '20', SIDECAR_SWE_SCAFFOLD_VERSION: '1.0.0' };
    const run = resolveEnvelopeRun(anthropicRun, env, '9.9.9');
    expect(run.model).toBe('claude-haiku-4-5-20251001');
    expect(run.maxIterations).toBe(50);
    expect(run.scaffoldVersion).toBe('5.1.0');
  });

  it('omits quantization for a hosted backend even when SIDECAR_SWE_QUANT is set', () => {
    expect(resolveEnvelopeRun(anthropicRun, { SIDECAR_SWE_QUANT: 'Q4_K_M' }, '9.9.9').quantization).toBeUndefined();
  });

  it('carries quantization for an Ollama run', () => {
    const run = resolveEnvelopeRun({ ...anthropicRun, backend: 'ollama' }, { SIDECAR_SWE_QUANT: 'Q4_K_M' }, '9.9.9');
    expect(run.quantization).toBe('Q4_K_M');
  });

  it('falls back to env, then the shipped defaults, when there is no manifest', () => {
    expect(resolveEnvelopeRun(null, {}, '9.9.9')).toEqual({
      model: 'gemma4:e4b',
      backend: 'ollama',
      maxIterations: 50,
      scaffoldVersion: '9.9.9',
      quantization: 'unknown',
    });
    expect(resolveEnvelopeRun(null, { SIDECAR_SWE_MAX_ITERS: '30' }, '9.9.9').maxIterations).toBe(30);
  });
});
