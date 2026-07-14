import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubLoopState } from './testHelpers.js';

// ---------------------------------------------------------------------------
// Tests for builtInHooks.ts (loop helper hardening).
//
// `defaultPolicyHooks()` adapts the four existing post-turn helpers
// (autoFix / stub validator / critic / completion gate) to the
// PolicyHook interface defined in policyHook.ts. The underlying
// helpers are tested separately; these tests pin the adapter wiring:
//
//   1. The default list contains exactly 4 hooks in the expected order.
//   2. Each adapter short-circuits to `mutated: false` when its
//      required context fields are missing (defensive coding — the
//      helpers would throw otherwise).
//   3. afterToolResults delegates to the right helper and reports
//      `mutated` from its return value (or inferred from
//      state.messages.length delta, in critic's case).
//   4. The completionGate hook implements BOTH afterToolResults
//      (recording) and onEmptyResponse (injection) phases.
// ---------------------------------------------------------------------------

vi.mock('./autoFix.js', () => ({
  applyAutoFix: vi.fn(async () => false),
}));
vi.mock('./stubCheck.js', () => ({
  applyStubCheck: vi.fn(() => false),
}));
vi.mock('./criticHook.js', () => ({
  applyCritic: vi.fn(async () => {}),
}));
vi.mock('./gate.js', () => ({
  recordGateToolUses: vi.fn(),
  maybeInjectCompletionGate: vi.fn(async () => 'skip'),
}));

import { defaultPolicyHooks } from './builtInHooks.js';
import { applyAutoFix } from './autoFix.js';
import { applyStubCheck } from './stubCheck.js';
import { applyCritic } from './criticHook.js';
import { recordGateToolUses, maybeInjectCompletionGate } from './gate.js';
import type { HookContext } from './policyHook.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';

function stubContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    client: {} as HookContext['client'],
    config: {} as HookContext['config'],
    callbacks: {
      onText: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onDone: vi.fn(),
    },
    options: {} as HookContext['options'],
    signal: new AbortController().signal,
    runId: 'test-run-id',
    ...overrides,
  };
}

const sampleToolUse: ToolUseContentBlock = {
  type: 'tool_use',
  id: 'tu-1',
  name: 'write_file',
  input: { path: 'x.ts', content: 'y' },
};
const sampleToolResult: ToolResultContentBlock = {
  type: 'tool_result',
  tool_use_id: 'tu-1',
  content: 'ok',
  is_error: false,
};

beforeEach(() => {
  vi.mocked(applyAutoFix).mockClear();
  vi.mocked(applyStubCheck).mockClear();
  vi.mocked(applyCritic).mockClear();
  vi.mocked(recordGateToolUses).mockClear();
  vi.mocked(maybeInjectCompletionGate).mockClear();
});

describe('defaultPolicyHooks list shape', () => {
  it('returns the hooks in a stable order', () => {
    const hooks = defaultPolicyHooks();
    expect(hooks.map((h) => h.name)).toEqual([
      'autoFix',
      'isolateRewrite',
      'unappliedEdit',
      'stubValidator',
      'adversarialCritic',
      'actionReprompt',
      'completionGate',
      'analysisCritic',
    ]);
  });

  it('the critic runs at COMPLETION, never after each tool batch', () => {
    // The bug this pins. The critic used to implement `afterToolResults`, firing
    // once per successful write_file / edit_file — so on a multi-file change it
    // reviewed file A alone, mid-refactor, before file B existed, and reported the
    // real-but-irrelevant problems of an unfinished job. With blocking on it then
    // sent the agent to fix a phantom: the SWE-bench arm carrying the critic
    // terminated ~7.5x faster while producing MORE empty patches.
    //
    // A critic reviews work. It belongs at the boundary where the work is done.
    const critic = defaultPolicyHooks().find((h) => h.name === 'adversarialCritic')!;
    expect(critic.onEmptyResponse).toBeDefined();
    expect(critic.afterToolResults).toBeUndefined();
  });

  it('returns a fresh array on each call so the orchestrator can mutate without aliasing', () => {
    const a = defaultPolicyHooks();
    const b = defaultPolicyHooks();
    expect(a).not.toBe(b);
    // But the underlying hook objects ARE the same references — they're
    // module-level constants. Aliasing of the list is what we prevent.
    expect(a[0]).toBe(b[0]);
  });
});

describe('autoFix adapter', () => {
  const hook = defaultPolicyHooks()[0];

  it('short-circuits to mutated:false when pendingToolUses is missing', async () => {
    const result = await hook.afterToolResults!(stubLoopState(), stubContext({ pendingToolUses: undefined }));
    expect(result).toEqual({ mutated: false });
    expect(applyAutoFix).not.toHaveBeenCalled();
  });

  it('delegates to applyAutoFix and returns its boolean as mutated', async () => {
    vi.mocked(applyAutoFix).mockResolvedValueOnce(true);
    const result = await hook.afterToolResults!(stubLoopState(), stubContext({ pendingToolUses: [sampleToolUse] }));
    expect(result?.mutated).toBe(true);
    expect(applyAutoFix).toHaveBeenCalledOnce();
  });
});

describe('stubValidator adapter', () => {
  const hook = defaultPolicyHooks()[3];

  it('short-circuits when pendingToolUses is missing', async () => {
    const result = await hook.afterToolResults!(stubLoopState(), stubContext({ pendingToolUses: undefined }));
    expect(result).toEqual({ mutated: false });
    expect(applyStubCheck).not.toHaveBeenCalled();
  });

  it('wraps synchronous applyStubCheck in an async return', async () => {
    vi.mocked(applyStubCheck).mockReturnValueOnce(true);
    const result = await hook.afterToolResults!(stubLoopState(), stubContext({ pendingToolUses: [sampleToolUse] }));
    expect(result?.mutated).toBe(true);
  });
});

describe('adversarialCritic adapter', () => {
  const hook = defaultPolicyHooks().find((h) => h.name === 'adversarialCritic')!;

  // The critic now runs in onEmptyResponse — at the completion boundary, over the
  // run's cumulative edits — not in afterToolResults after every tool batch. It
  // reads the edited-file set from gateState, so it needs no tool uses at all.

  it('short-circuits when fullText is missing', async () => {
    const r = await hook.onEmptyResponse!(stubLoopState(), stubContext({}));
    expect(r?.mutated).toBe(false);
    expect(applyCritic).not.toHaveBeenCalled();
  });

  it('infers mutated from state.messages.length delta (critic returns void)', async () => {
    vi.mocked(applyCritic).mockImplementationOnce(async (state) => {
      state.messages.push({ role: 'user', content: 'injected by critic' });
    });
    const state = stubLoopState();
    const result = await hook.onEmptyResponse!(state, stubContext({ fullText: 'some assistant text' }));
    expect(result?.mutated).toBe(true);
    expect(state.messages).toHaveLength(1);
  });

  it('reports mutated:false when critic runs but does not inject', async () => {
    vi.mocked(applyCritic).mockResolvedValueOnce(undefined);
    const result = await hook.onEmptyResponse!(stubLoopState(), stubContext({ fullText: 'some text' }));
    expect(result?.mutated).toBe(false);
    expect(applyCritic).toHaveBeenCalledOnce();
  });
});

describe('completionGate adapter', () => {
  const hook = defaultPolicyHooks()[6]; // autoFix, isolateRewrite, unappliedEdit, stub, critic, actionReprompt, completionGate

  describe('afterToolResults phase (recording)', () => {
    it('short-circuits when pendingToolUses or toolResults are missing', async () => {
      const result = await hook.afterToolResults!(
        stubLoopState(),
        stubContext({ pendingToolUses: undefined, toolResults: [sampleToolResult] }),
      );
      expect(result?.mutated).toBe(false);
      expect(recordGateToolUses).not.toHaveBeenCalled();
    });

    it('records tool uses into gate state and always reports mutated:false', async () => {
      const state = stubLoopState();
      const result = await hook.afterToolResults!(
        state,
        stubContext({ pendingToolUses: [sampleToolUse], toolResults: [sampleToolResult] }),
      );
      expect(recordGateToolUses).toHaveBeenCalledOnce();
      expect(result?.mutated).toBe(false); // recording never mutates history
    });
  });

  describe('onEmptyResponse phase (injection)', () => {
    it('returns mutated:true when maybeInjectCompletionGate returns "injected"', async () => {
      vi.mocked(maybeInjectCompletionGate).mockResolvedValueOnce('injected');
      const result = await hook.onEmptyResponse!(stubLoopState(), stubContext());
      expect(result?.mutated).toBe(true);
    });

    it('returns mutated:false on any non-"injected" outcome', async () => {
      vi.mocked(maybeInjectCompletionGate).mockResolvedValueOnce('skip');
      const result = await hook.onEmptyResponse!(stubLoopState(), stubContext());
      expect(result?.mutated).toBe(false);
    });
  });
});
