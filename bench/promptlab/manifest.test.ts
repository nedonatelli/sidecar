import { describe, it, expect } from 'vitest';
import { assertComparable, hash, type RunManifest } from './manifest.js';

const base = (over: Partial<RunManifest> = {}): RunManifest => ({
  model: 'gemma4:e4b',
  seed: 42,
  temperature: 0,
  numCtx: 32768,
  cases: ['a', 'b'],
  trials: 3,
  caseTimeoutMs: 900_000,
  systemPromptMode: 'full',
  toolTier: 'full',
  ragOrientation: false,
  configOverrides: {},
  systemPromptHash: 'aaa',
  toolCatalogHash: 'bbb',
  createdAt: '2026-08-19T00:00:00Z',
  ...over,
});

describe('assertComparable', () => {
  it('accepts two arms differing only on the declared axis', () => {
    const v = assertComparable(base(), base({ systemPromptMode: 'none', systemPromptHash: 'ccc' }), [
      'systemPromptMode',
    ]);
    expect(v.comparable).toBe(true);
    expect(v.unexpectedDiffs).toEqual([]);
  });

  it('rejects a tool-catalog change while testing the system prompt', () => {
    // The live failure: grep's description gained one sentence between two
    // harnesses and the baseline silently moved from 3/3 to 0/3.
    const v = assertComparable(
      base(),
      base({ systemPromptMode: 'none', systemPromptHash: 'ccc', toolCatalogHash: 'zzz' }),
      ['systemPromptMode'],
    );
    expect(v.comparable).toBe(false);
    expect(v.unexpectedDiffs.join()).toMatch(/toolCatalogHash changed but no axis explains it/);
  });

  it('rejects a model or trial-count mismatch outright', () => {
    expect(assertComparable(base(), base({ model: 'granite4.1:3b' }), []).comparable).toBe(false);
    expect(assertComparable(base(), base({ trials: 5 }), []).comparable).toBe(false);
  });

  it('warns when a run is unseeded', () => {
    const v = assertComparable(base({ seed: null }), base({ seed: null }), []);
    expect(v.warnings.join()).toMatch(/unseeded/);
  });

  it('warns when temperature is non-zero without a seed', () => {
    // Exactly the configuration that produced 0/3 and 2/3 for the same arm.
    const v = assertComparable(base({ seed: null, temperature: 0.2 }), base({ seed: null, temperature: 0.2 }), []);
    expect(v.warnings.join()).toMatch(/without a seed/);
  });

  it('hashes deterministically and differs on any byte', () => {
    expect(hash('abc')).toBe(hash('abc'));
    expect(hash('abc')).not.toBe(hash('abd'));
  });
});
