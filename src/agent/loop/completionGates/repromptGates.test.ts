import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../completionGate.js', () => ({
  unreadMention: vi.fn(() => null),
  noReadReprompt: vi.fn((file: string) => `Read ${file} first.`),
  buildNoShellReprompt: vi.fn(() => null),
  buildNoGroundingReprompt: vi.fn(() => null),
  buildUnverifiedClaimReprompt: vi.fn(async () => null),
  buildMcpMutationVerifyReprompt: vi.fn(() => null),
  unwrittenMentions: vi.fn(async () => []),
  noFileWriteReprompt: vi.fn((files: string[]) => `Write ${files.join(', ')}.`),
}));

import { noReadGate, unverifiedClaimGate, noFileWriteGate } from './repromptGates.js';
import { unreadMention, unwrittenMentions, buildUnverifiedClaimReprompt } from '../../completionGate.js';
import type { AgentDecision } from '../../decisions.js';
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

function makeState(decisions: AgentDecision[] = []) {
  return {
    gateState: { editedFiles: new Set<string>(), currentUserRequest: 'do the thing' },
    messages: [] as LoopState['messages'],
    logger: { info: vi.fn(), logDecision: (d: AgentDecision) => decisions.push(d) },
    iteration: 4,
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
    vi.mocked(unreadMention).mockReturnValue('src/a.py');
    const state = makeState();
    const c = ctx();

    expect(await noReadGate.maybeInject(state, c)).toBe('injected');
    expect(state.messages).toHaveLength(1);
    expect(JSON.stringify(state.messages[0])).toContain('Read src/a.py first.');
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

// #391: the SWE prompt wraps the issue in harness instructions whose example
// test path the no-read gate named as if the user had asked about it.
describe('file references (fileReferenceText)', () => {
  it('no-read reads file names from fileReferenceText when set, else the request', async () => {
    // Fresh states: an earlier test's mockReturnValue survives clearAllMocks,
    // so a shared state would latch on the first call.
    await noReadGate.maybeInject(makeState(), ctx());
    expect(vi.mocked(unreadMention).mock.calls[0][2]).toBe('do the thing');

    const state = makeState();
    state.gateState.fileReferenceText = 'the issue text';
    await noReadGate.maybeInject(state, ctx());
    expect(vi.mocked(unreadMention).mock.calls[1][2]).toBe('the issue text');
  });

  it('no-file-write keeps the request for write intent and passes fileReferenceText for the names', async () => {
    const state = makeState();
    state.gateState.fileReferenceText = 'the issue text';
    await noFileWriteGate.maybeInject(state, ctx());
    const args = vi.mocked(unwrittenMentions).mock.calls[0];
    expect(args[2]).toBe('do the thing');
    expect(args[4]).toBe('the issue text');
  });
});

// #390: the trajectory records which gate fired and the file it named, so the
// two nudges that both open with "The request mentions" can be told apart.
describe('a fired gate is recorded as a reprompt decision', () => {
  it('no-read records its source and the file it asks for', async () => {
    vi.mocked(unreadMention).mockReturnValueOnce('testing/test_skipping.py');
    const decisions: AgentDecision[] = [];
    await noReadGate.maybeInject(makeState(decisions), ctx());
    expect(decisions).toEqual([
      {
        kind: 'reprompt',
        action: 'injected',
        source: 'no-read',
        iteration: 4,
        files: ['testing/test_skipping.py'],
        text: 'Read testing/test_skipping.py first.',
      },
    ]);
  });

  it('no-file-write records every unwritten file', async () => {
    vi.mocked(unwrittenMentions).mockResolvedValueOnce(['src/a.ts', 'src/b.ts']);
    const decisions: AgentDecision[] = [];
    await noFileWriteGate.maybeInject(makeState(decisions), ctx());
    expect(decisions).toMatchObject([{ source: 'no-file-write', files: ['src/a.ts', 'src/b.ts'] }]);
  });

  it('a gate without files records none', async () => {
    vi.mocked(buildUnverifiedClaimReprompt).mockResolvedValueOnce('Verify that citation.');
    const decisions: AgentDecision[] = [];
    await unverifiedClaimGate.maybeInject(makeState(decisions), ctx());
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).not.toHaveProperty('files');
  });

  it('a gate that does not fire records nothing', async () => {
    vi.mocked(unreadMention).mockReturnValueOnce(null);
    const decisions: AgentDecision[] = [];
    await noReadGate.maybeInject(makeState(decisions), ctx());
    expect(decisions).toEqual([]);
  });
});
