import { describe, it, expect, vi } from 'vitest';
import { impactGate, numericalContractGate, analyticBoundGate } from './codeGraphGates.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

// buildImpactAdvisory (the advisory renderer) is tested in gateImpactAdvisory.test.ts.
// Here we pin the registry contract: these gates are ALWAYS enabled (their
// advisory must run regardless of the block flag), and they skip cleanly on a
// no-edit turn without touching the symbol-graph runtime.
const ctx = (): GateContext => ({
  config: { impactGateEnabled: false } as ReturnType<typeof getConfig>,
  options: {} as GateContext['options'],
  signal: new AbortController().signal,
  callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
});

const emptyState = () =>
  ({ gateState: { editedFiles: new Set<string>() }, messages: [], logger: undefined }) as unknown as LoopState;

describe('code-graph gates', () => {
  it('are always enabled (the advisory runs regardless of the block flag)', () => {
    const c = { impactGateEnabled: false } as ReturnType<typeof getConfig>;
    expect(impactGate.enabled(c)).toBe(true);
    expect(numericalContractGate.enabled(c)).toBe(true);
    expect(analyticBoundGate.enabled(c)).toBe(true);
  });

  it('skip cleanly on a no-edit turn (no runtime access)', async () => {
    for (const gate of [impactGate, numericalContractGate, analyticBoundGate]) {
      const s = emptyState();
      expect(await gate.maybeInject(s, ctx())).toBe('skip');
      expect(s.messages).toHaveLength(0);
    }
  });
});
