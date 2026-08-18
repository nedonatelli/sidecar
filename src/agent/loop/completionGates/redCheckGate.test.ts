import { describe, it, expect, vi } from 'vitest';
import { redCheckGate } from './redCheckGate.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

const ctx = (o: Partial<ReturnType<typeof getConfig>> = {}): GateContext => ({
  config: { completionGateEnabled: true, redCheckGateEnabled: true, ...o } as ReturnType<typeof getConfig>,
  options: {} as GateContext['options'],
  signal: new AbortController().signal,
  callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
});

const makeState = (failedCheckOutput?: string) =>
  ({
    gateState: { failedCheckOutput, redCheckInjections: 0 },
    messages: [],
    logger: undefined,
  }) as unknown as LoopState;

describe('redCheckGate.enabled', () => {
  it('is on with the completion gate + its own flag, off when either is disabled', () => {
    expect(redCheckGate.enabled(ctx().config)).toBe(true);
    expect(redCheckGate.enabled(ctx({ completionGateEnabled: false }).config)).toBe(false);
    expect(redCheckGate.enabled(ctx({ redCheckGateEnabled: false }).config)).toBe(false);
  });
});

describe('redCheckGate.maybeInject', () => {
  it('skips when there is no failing check', async () => {
    expect(await redCheckGate.maybeInject(makeState(undefined), ctx())).toBe('skip');
  });

  it('injects on a red check, latches primary-work, and quotes the failure', async () => {
    const s = makeState('TSError: 2 errors');
    expect(await redCheckGate.maybeInject(s, ctx())).toBe('injected');
    expect(s.gateState.redCheckInjections).toBe(1);
    expect(s.gateState.lastInjectionWasPrimaryWork).toBe(true);
    expect(JSON.stringify(s.messages[0])).toContain('TSError: 2 errors');
  });

  it('stands down after the 2-injection budget', async () => {
    const s = makeState('still failing');
    s.gateState.redCheckInjections = 2;
    expect(await redCheckGate.maybeInject(s, ctx())).toBe('skip');
  });
});
