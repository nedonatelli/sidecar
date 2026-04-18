import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for builtInHooks.ts (v0.65 chunk 2a — loop helper hardening).
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
import type { LoopState } from './state.js';
import type { HookContext } from './policyHook.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: undefined,
    changelog: undefined,
    mcpManager: undefined,
    messages: [],
    iteration: 1,
    totalChars: 0,
    recentToolCalls: [],
    autoFixRetriesByFile: new Map(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map(),
    criticInjectionsByTestHash: new Map(),
    toolCallCounts: new Map(),
    gateState: {} as LoopState['gateState'],
    ...overrides,
  };
}

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
  it('returns 4 hooks in a stable order', () => {
    const hooks = defaultPolicyHooks();
    expect(hooks.map((h) => h.name)).toEqual(['autoFix', 'stubValidator', 'adversarialCritic', 'completionGate']);
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
    const result = await hook.afterToolResults!(stubState(), stubContext({ pendingToolUses: undefined }));
    expect(result).toEqual({ mutated: false });
    expect(applyAutoFix).not.toHaveBeenCalled();
  });

  it('delegates to applyAutoFix and returns its boolean as mutated', async () => {
    vi.mocked(applyAutoFix).mockResolvedValueOnce(true);
    const result = await hook.afterToolResults!(stubState(), stubContext({ pendingToolUses: [sampleToolUse] }));
    expect(result?.mutated).toBe(true);
    expect(applyAutoFix).toHaveBeenCalledOnce();
  });
});

describe('stubValidator adapter', () => {
  const hook = defaultPolicyHooks()[1];

  it('short-circuits when pendingToolUses is missing', async () => {
    const result = await hook.afterToolResults!(stubState(), stubContext({ pendingToolUses: undefined }));
    expect(result).toEqual({ mutated: false });
    expect(applyStubCheck).not.toHaveBeenCalled();
  });

  it('wraps synchronous applyStubCheck in an async return', async () => {
    vi.mocked(applyStubCheck).mockReturnValueOnce(true);
    const result = await hook.afterToolResults!(stubState(), stubContext({ pendingToolUses: [sampleToolUse] }));
    expect(result?.mutated).toBe(true);
  });
});

describe('adversarialCritic adapter', () => {
  const hook = defaultPolicyHooks()[2];

  it('short-circuits when any of pendingToolUses / toolResults / fullText is missing', async () => {
    // Missing fullText
    const r1 = await hook.afterToolResults!(
      stubState(),
      stubContext({ pendingToolUses: [sampleToolUse], toolResults: [sampleToolResult] }),
    );
    expect(r1?.mutated).toBe(false);
    expect(applyCritic).not.toHaveBeenCalled();
  });

  it('infers mutated from state.messages.length delta (critic returns void)', async () => {
    // Critic stub that pushes a message — should produce mutated:true
    vi.mocked(applyCritic).mockImplementationOnce(async (state) => {
      state.messages.push({ role: 'user', content: 'injected by critic' });
    });
    const state = stubState();
    const result = await hook.afterToolResults!(
      state,
      stubContext({
        pendingToolUses: [sampleToolUse],
        toolResults: [sampleToolResult],
        fullText: 'some assistant text',
      }),
    );
    expect(result?.mutated).toBe(true);
    expect(state.messages).toHaveLength(1);
  });

  it('reports mutated:false when critic runs but does not inject', async () => {
    vi.mocked(applyCritic).mockResolvedValueOnce(undefined);
    const result = await hook.afterToolResults!(
      stubState(),
      stubContext({
        pendingToolUses: [sampleToolUse],
        toolResults: [sampleToolResult],
        fullText: 'some text',
      }),
    );
    expect(result?.mutated).toBe(false);
    expect(applyCritic).toHaveBeenCalledOnce();
  });
});

describe('completionGate adapter', () => {
  const hook = defaultPolicyHooks()[3];

  describe('afterToolResults phase (recording)', () => {
    it('short-circuits when pendingToolUses or toolResults are missing', async () => {
      const result = await hook.afterToolResults!(
        stubState(),
        stubContext({ pendingToolUses: undefined, toolResults: [sampleToolResult] }),
      );
      expect(result?.mutated).toBe(false);
      expect(recordGateToolUses).not.toHaveBeenCalled();
    });

    it('records tool uses into gate state and always reports mutated:false', async () => {
      const state = stubState();
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
      const result = await hook.onEmptyResponse!(stubState(), stubContext());
      expect(result?.mutated).toBe(true);
    });

    it('returns mutated:false on any non-"injected" outcome', async () => {
      vi.mocked(maybeInjectCompletionGate).mockResolvedValueOnce('skip');
      const result = await hook.onEmptyResponse!(stubState(), stubContext());
      expect(result?.mutated).toBe(false);
    });
  });
});
