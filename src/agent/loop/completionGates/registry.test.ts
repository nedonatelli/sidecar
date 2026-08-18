import { describe, it, expect } from 'vitest';
import { runGateRegistry } from './registry.js';
import type { CompletionGate, GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

function ctx(overrides: Partial<ReturnType<typeof getConfig>> = {}): GateContext {
  return {
    config: { behavioralVerificationGateEnabled: false, ...overrides } as ReturnType<typeof getConfig>,
    options: {} as GateContext['options'],
    signal: new AbortController().signal,
    callbacks: { onText: () => {} } as unknown as GateContext['callbacks'],
  };
}

const state = {} as LoopState;

/** A gate that records when it runs, into `calls`. */
function probe(calls: string[], name: string, enabled: boolean, outcome: 'injected' | 'skip'): CompletionGate {
  return {
    name,
    enabled: () => enabled,
    maybeInject: async () => {
      calls.push(name);
      return outcome;
    },
  };
}

describe('runGateRegistry — real registry', () => {
  it('returns skip with the default config (every registered gate off = bare loop)', async () => {
    expect(await runGateRegistry(state, ctx())).toBe('skip');
  });
});

describe('runGateRegistry — loop contract', () => {
  it('runs enabled gates in order and never calls disabled ones', async () => {
    const calls: string[] = [];
    const result = await runGateRegistry(state, ctx(), [
      probe(calls, 'a', false, 'injected'),
      probe(calls, 'b', true, 'skip'),
      probe(calls, 'c', true, 'skip'),
    ]);
    expect(result).toBe('skip');
    expect(calls).toEqual(['b', 'c']); // 'a' disabled → skipped
  });

  it('short-circuits on the first gate that injects', async () => {
    const calls: string[] = [];
    const result = await runGateRegistry(state, ctx(), [
      probe(calls, 'a', true, 'skip'),
      probe(calls, 'b', true, 'injected'),
      probe(calls, 'c', true, 'injected'),
    ]);
    expect(result).toBe('injected');
    expect(calls).toEqual(['a', 'b']); // 'c' never reached
  });
});
