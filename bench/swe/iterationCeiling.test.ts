import { describe, it, expect, afterEach } from 'vitest';
import { resolveIterationCeiling } from './iterationCeiling.js';
import { setUserTierOverrides } from '../../src/ollama/modelCapability.js';

describe('resolveIterationCeiling', () => {
  afterEach(() => setUserTierOverrides({}));

  it("gives a strong model the product's tier default, not a harness 50", () => {
    expect(resolveIterationCeiling('claude-haiku-4-5-20251001', undefined)).toEqual({
      maxIterations: 150,
      source: 'tier:strong',
    });
  });

  it('keeps 50 for a medium-tier local model', () => {
    expect(resolveIterationCeiling('gemma4:e4b', undefined)).toEqual({ maxIterations: 50, source: 'tier:medium' });
  });

  it('follows a user tier override, as the product does', () => {
    setUserTierOverrides({ 'gemma4:e4b': 'strong' });
    expect(resolveIterationCeiling('gemma4:e4b', undefined).maxIterations).toBe(150);
  });

  it('applies a scaffolding.overrides maxIterations on top of the tier', () => {
    expect(resolveIterationCeiling('claude-haiku-4-5-20251001', undefined, { maxIterations: 90 }).maxIterations).toBe(
      90,
    );
  });

  it('lets an explicit SIDECAR_SWE_MAX_ITERS win, and says so', () => {
    expect(resolveIterationCeiling('claude-haiku-4-5-20251001', '50')).toEqual({ maxIterations: 50, source: 'env' });
  });

  it('treats an empty env value as unset', () => {
    expect(resolveIterationCeiling('gemma4:e4b', '  ').source).toBe('tier:medium');
  });

  it('rejects a value that is not a positive integer', () => {
    expect(() => resolveIterationCeiling('gemma4:e4b', 'fifty')).toThrow(/positive integer/);
    expect(() => resolveIterationCeiling('gemma4:e4b', '0')).toThrow(/positive integer/);
  });
});
