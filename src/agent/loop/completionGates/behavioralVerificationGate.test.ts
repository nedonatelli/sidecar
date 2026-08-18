import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../completionGate.js', () => ({
  buildBehavioralVerificationReprompt: vi.fn(async () => 'Write a test that exercises the edited behavior.'),
}));

import { behavioralVerificationGate as gate } from './behavioralVerificationGate.js';
import { buildBehavioralVerificationReprompt } from '../../completionGate.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

function ctx(enabled: boolean): GateContext {
  return {
    config: { behavioralVerificationGateEnabled: enabled } as ReturnType<typeof getConfig>,
    options: {} as GateContext['options'],
    signal: new AbortController().signal,
    callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
  };
}

function makeState() {
  return {
    gateState: {
      editedFiles: new Set(['a.ts']),
      currentUserRequest: 'fix the bug',
      testsRunForFiles: new Set<string>(),
      passingTestFiles: new Set<string>(),
      projectTestsPassed: false,
      behavioralVerificationInjections: 0,
    },
    messages: [] as LoopState['messages'],
    logger: undefined,
    lastFailureOutput: undefined,
  } as unknown as LoopState;
}

beforeEach(() => vi.mocked(buildBehavioralVerificationReprompt).mockClear());

describe('behavioralVerificationGate', () => {
  it('is dormant when its flag is off (default) — enabled() is false', () => {
    expect(gate.enabled(ctx(false).config)).toBe(false);
    expect(gate.enabled(ctx(true).config)).toBe(true);
  });

  it('injects a reprompt and increments its budget when a reprompt is produced', async () => {
    const state = makeState();
    const c = ctx(true);
    expect(await gate.maybeInject(state, c)).toBe('injected');
    expect(state.gateState.behavioralVerificationInjections).toBe(1);
    expect(state.messages).toHaveLength(1);
    expect(JSON.stringify(state.messages[0])).toContain('exercises the edited behavior');
    expect(c.callbacks.onText).toHaveBeenCalled();
  });

  it('skips (no injection) when the reprompt builder returns null — nothing to say', async () => {
    vi.mocked(buildBehavioralVerificationReprompt).mockResolvedValueOnce(null);
    const state = makeState();
    expect(await gate.maybeInject(state, ctx(true))).toBe('skip');
    expect(state.gateState.behavioralVerificationInjections).toBe(0);
    expect(state.messages).toHaveLength(0);
  });

  it('stands down once the injection budget (2) is spent', async () => {
    const state = makeState();
    state.gateState.behavioralVerificationInjections = 2;
    expect(await gate.maybeInject(state, ctx(true))).toBe('skip');
    expect(buildBehavioralVerificationReprompt).not.toHaveBeenCalled();
  });
});
