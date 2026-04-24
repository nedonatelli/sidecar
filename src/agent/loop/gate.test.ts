import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for gate.ts (v0.65 chunk 2b — loop helper hardening).
//
// Two entry points:
//   - recordGateToolUses — feeds tool uses + results into gateState
//   - maybeInjectCompletionGate — decides whether to fire the gate on
//     the empty-response branch, returns 'injected' | 'skip'
//
// The underlying completionGate module (createGateState, recordToolCall,
// checkCompletionGate, buildGateInjection) is tested separately — these
// tests pin the orchestration-layer behavior: skip conditions, cap
// enforcement, and state-mutation + message-push on injection.
// ---------------------------------------------------------------------------

vi.mock('../completionGate.js', () => ({
  recordToolCall: vi.fn(),
  checkCompletionGate: vi.fn(async () => []),
  buildGateInjection: vi.fn(() => 'Please verify your changes before finishing.'),
}));

import { recordGateToolUses, maybeInjectCompletionGate } from './gate.js';
import { recordToolCall, checkCompletionGate } from '../completionGate.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';

function stubGateState() {
  return {
    editedFiles: new Set<string>(),
    gateInjections: 0,
  } as unknown as LoopState['gateState'];
}

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    runId: 'test-task',
    config: {} as import('../../config/settings.js').SideCarConfig,
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
    gateState: stubGateState(),
    currentEditPlan: null,
    ...overrides,
  };
}

function stubCallbacks(): AgentCallbacks & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    onText: (t: string) => texts.push(t),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

function stubConfig(overrides: Partial<ReturnType<typeof getConfig>> = {}): ReturnType<typeof getConfig> {
  return { completionGateEnabled: true, ...overrides } as unknown as ReturnType<typeof getConfig>;
}

function use(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
}

function result(id: string, isError = false): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError };
}

beforeEach(() => {
  vi.mocked(recordToolCall).mockClear();
  vi.mocked(checkCompletionGate).mockClear();
});

describe('recordGateToolUses', () => {
  it('calls recordToolCall once per matching (use, result) pair', () => {
    const state = stubState();
    const uses = [use('write_file', { path: 'a.ts' }), use('read_file', { path: 'b.ts' })];
    const results = [result('tu-write_file'), result('tu-read_file')];
    recordGateToolUses(state, uses, results);
    expect(recordToolCall).toHaveBeenCalledTimes(2);
  });

  it('skips indexes where the tool result is missing (partial execution fell off)', () => {
    const state = stubState();
    const uses = [use('write_file', { path: 'a.ts' }), use('read_file', { path: 'b.ts' })];
    // Second result is missing — simulate truncated execution.
    const results = [result('tu-write_file')] as unknown as ToolResultContentBlock[];
    recordGateToolUses(state, uses, results);
    expect(recordToolCall).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when pendingToolUses is empty', () => {
    recordGateToolUses(stubState(), [], []);
    expect(recordToolCall).not.toHaveBeenCalled();
  });
});

describe('maybeInjectCompletionGate — skip paths', () => {
  const options: AgentOptions = {};
  const signal = new AbortController().signal;

  it('skips when signal is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const state = stubState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, ctrl.signal, stubCallbacks())).toBe('skip');
    expect(checkCompletionGate).not.toHaveBeenCalled();
  });

  it('skips in plan mode even when edits are present', async () => {
    const state = stubState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(
      await maybeInjectCompletionGate(state, stubConfig(), { approvalMode: 'plan' }, signal, stubCallbacks()),
    ).toBe('skip');
  });

  it('skips when completionGateEnabled is false', async () => {
    const state = stubState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(
      await maybeInjectCompletionGate(
        state,
        stubConfig({ completionGateEnabled: false }),
        options,
        signal,
        stubCallbacks(),
      ),
    ).toBe('skip');
  });

  it('skips when no files were edited (gate has nothing to verify)', async () => {
    const state = stubState(); // editedFiles starts empty
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks())).toBe('skip');
  });

  it('skips + warns when gate has already injected MAX_GATE_INJECTIONS times', async () => {
    const warn = vi.fn();
    const state = stubState({
      logger: { warn, info: vi.fn() } as unknown as LoopState['logger'],
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 2 } as unknown as LoopState['gateState'],
    });
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks())).toBe('skip');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('exhausted');
  });

  it('skips quietly (no warn) when gate exhausted but editedFiles is empty — no unverified work left', async () => {
    // Theoretically unreachable (the edited-files check would fire
    // first), but tests the defensive branch in the helper.
    const warn = vi.fn();
    const state = stubState({
      logger: { warn, info: vi.fn() } as unknown as LoopState['logger'],
      gateState: { editedFiles: new Set(), gateInjections: 2 } as unknown as LoopState['gateState'],
    });
    await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks());
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips when checkCompletionGate returns no findings', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([]);
    const state = stubState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks())).toBe('skip');
    expect(checkCompletionGate).toHaveBeenCalledOnce();
  });
});

describe('maybeInjectCompletionGate — injection path', () => {
  it('returns "injected" + pushes a user message when findings are present', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([
      { kind: 'unverified-edit', file: 'a.ts', hint: 'run tests' },
    ] as unknown as Awaited<ReturnType<typeof checkCompletionGate>>);
    const state = stubState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    const cb = stubCallbacks();
    const outcome = await maybeInjectCompletionGate(state, stubConfig(), {}, new AbortController().signal, cb);
    expect(outcome).toBe('injected');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect((state.gateState as { gateInjections: number }).gateInjections).toBe(1);
    expect(cb.texts[0]).toContain('Verifying');
  });

  it('logs the injection with index/cap summary', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([{ kind: 'x', file: 'a', hint: 'y' }] as unknown as Awaited<
      ReturnType<typeof checkCompletionGate>
    >);
    const info = vi.fn();
    const state = stubState({
      logger: { info, warn: vi.fn() } as unknown as LoopState['logger'],
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    await maybeInjectCompletionGate(state, stubConfig(), {}, new AbortController().signal, stubCallbacks());
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('#1/2');
  });
});
