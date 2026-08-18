import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../completionGate.js', () => ({
  buildNoReadReprompt: vi.fn(() => null),
  buildNoShellReprompt: vi.fn(() => null),
  buildNoGroundingReprompt: vi.fn(() => null),
  buildUnverifiedClaimReprompt: vi.fn(async () => null),
  buildMcpMutationVerifyReprompt: vi.fn(() => null),
  buildNoFileWriteReprompt: vi.fn(async () => null),
}));

import { noReadGate, unverifiedClaimGate, noFileWriteGate } from './repromptGates.js';
import { buildNoReadReprompt, buildUnverifiedClaimReprompt } from '../../completionGate.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

function ctx(completionGateEnabled = true): GateContext {
  return {
    config: { completionGateEnabled } as ReturnType<typeof getConfig>,
    options: {} as GateContext['options'],
    signal: new AbortController().signal,
    callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
  };
}

function makeState() {
  return {
    gateState: { editedFiles: new Set<string>(), currentUserRequest: 'do the thing' },
    messages: [] as LoopState['messages'],
    logger: undefined,
  } as unknown as LoopState;
}

beforeEach(() => vi.clearAllMocks());

describe('reprompt gates — enable flag', () => {
  it('are gated by the completion-gate master', () => {
    expect(noReadGate.enabled({ completionGateEnabled: true } as ReturnType<typeof getConfig>)).toBe(true);
    expect(noReadGate.enabled({ completionGateEnabled: false } as ReturnType<typeof getConfig>)).toBe(false);
  });
});

describe('reprompt gate behavior (via noReadGate)', () => {
  it('skips when the builder returns null (nothing to nudge)', async () => {
    const state = makeState();
    expect(await noReadGate.maybeInject(state, ctx())).toBe('skip');
    expect(state.messages).toHaveLength(0);
  });

  it('injects, latches its fired flag, and does not re-fire', async () => {
    vi.mocked(buildNoReadReprompt).mockReturnValue('Read the file first.');
    const state = makeState();
    const c = ctx();

    expect(await noReadGate.maybeInject(state, c)).toBe('injected');
    expect(state.messages).toHaveLength(1);
    expect(JSON.stringify(state.messages[0])).toContain('Read the file first.');
    expect(c.callbacks.onText).toHaveBeenCalled();
    expect(state.gateState.noReadRepromptFired).toBe(true);

    // Second call: latched → skip, no new message even though the builder still returns text.
    expect(await noReadGate.maybeInject(state, c)).toBe('skip');
    expect(state.messages).toHaveLength(1);
  });

  it('awaits async builders (unverified-claim / no-file-write)', async () => {
    vi.mocked(buildUnverifiedClaimReprompt).mockResolvedValue('Verify that citation.');
    const state = makeState();
    expect(await unverifiedClaimGate.maybeInject(state, ctx())).toBe('injected');
    expect(state.gateState.unverifiedClaimRepromptFired).toBe(true);
    // noFileWriteGate uses a distinct latch; default mock returns null → skip.
    expect(await noFileWriteGate.maybeInject(makeState(), ctx())).toBe('skip');
  });
});
