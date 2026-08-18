import { describe, it, expect, vi } from 'vitest';
import { planIncompleteGate } from './planIncompleteGate.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

const ctx = (): GateContext => ({
  config: { completionGateEnabled: true } as ReturnType<typeof getConfig>,
  options: {} as GateContext['options'],
  signal: new AbortController().signal,
  callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
});

const makeState = (plan?: { current: number; steps: string[] }) =>
  ({
    planRef: plan ? { plan } : undefined,
    gateState: { planIncompleteInjections: 0, editedFiles: new Set<string>() },
    messages: [],
    logger: undefined,
  }) as unknown as LoopState;

describe('planIncompleteGate', () => {
  it('is gated by the completion-gate master', () => {
    expect(planIncompleteGate.enabled({ completionGateEnabled: true } as ReturnType<typeof getConfig>)).toBe(true);
    expect(planIncompleteGate.enabled({ completionGateEnabled: false } as ReturnType<typeof getConfig>)).toBe(false);
  });

  it('skips when there is no externalized plan', async () => {
    expect(await planIncompleteGate.maybeInject(makeState(undefined), ctx())).toBe('skip');
  });

  it('injects when the plan still has remaining steps, latching primary-work', async () => {
    const s = makeState({ current: 2, steps: ['a', 'b', 'c'] });
    expect(await planIncompleteGate.maybeInject(s, ctx())).toBe('injected');
    expect(s.gateState.lastInjectionWasPrimaryWork).toBe(true);
    expect(JSON.stringify(s.messages[0])).toContain('step 2 of 3');
  });

  it('skips when every step is done and no plan-named file is unwritten', async () => {
    // current == steps.length, and plain-text steps name no deliverables.
    const s = makeState({ current: 2, steps: ['do a thing', 'do another thing'] });
    expect(await planIncompleteGate.maybeInject(s, ctx())).toBe('skip');
    expect(s.messages).toHaveLength(0);
  });

  it('stands down after the 2-injection budget', async () => {
    const s = makeState({ current: 1, steps: ['a', 'b'] });
    s.gateState.planIncompleteInjections = 2;
    expect(await planIncompleteGate.maybeInject(s, ctx())).toBe('skip');
  });
});
