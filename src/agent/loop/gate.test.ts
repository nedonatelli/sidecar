import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stubLoopState, stubCallbacks } from './testHelpers.js';

// ---------------------------------------------------------------------------
// Tests for gate.ts (loop helper hardening).
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
  buildNoReadReprompt: vi.fn(() => null), // returns null by default — no reprompt needed
  buildNoShellReprompt: vi.fn(() => null), // returns null by default — no reprompt needed
  buildNoFileWriteReprompt: vi.fn(() => null), // returns null by default — no reprompt needed
  buildNoGroundingReprompt: vi.fn(() => null), // returns null by default — no reprompt needed
  buildUnverifiedClaimReprompt: vi.fn(async () => null), // async; returns null by default
  buildBehavioralVerificationReprompt: vi.fn(() => null), // returns null by default — no reprompt needed
  buildMcpMutationVerifyReprompt: vi.fn(() => null), // returns null by default — no reprompt needed
}));

import { recordGateToolUses, maybeInjectCompletionGate } from './gate.js';
import { recordToolCall, checkCompletionGate, buildMcpMutationVerifyReprompt } from '../completionGate.js';
import { setSymbolGraph } from '../tools/runtime.js';
import { SymbolGraph } from '../../config/symbolGraph.js';
import type { LoopState } from './state.js';
import type { AgentOptions } from '../loop.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';

function stubGateState() {
  return {
    editedFiles: new Set<string>(),
    gateInjections: 0,
  } as unknown as LoopState['gateState'];
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
    const state = stubLoopState({ gateState: stubGateState() });
    const uses = [use('write_file', { path: 'a.ts' }), use('read_file', { path: 'b.ts' })];
    const results = [result('tu-write_file'), result('tu-read_file')];
    recordGateToolUses(state, uses, results);
    expect(recordToolCall).toHaveBeenCalledTimes(2);
  });

  it('skips indexes where the tool result is missing (partial execution fell off)', () => {
    const state = stubLoopState({ gateState: stubGateState() });
    const uses = [use('write_file', { path: 'a.ts' }), use('read_file', { path: 'b.ts' })];
    // Second result is missing — simulate truncated execution.
    const results = [result('tu-write_file')] as unknown as ToolResultContentBlock[];
    recordGateToolUses(state, uses, results);
    expect(recordToolCall).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when pendingToolUses is empty', () => {
    recordGateToolUses(stubLoopState({ gateState: stubGateState() }), [], []);
    expect(recordToolCall).not.toHaveBeenCalled();
  });
});

describe('maybeInjectCompletionGate — skip paths', () => {
  const options: AgentOptions = {};
  const signal = new AbortController().signal;

  it('skips when signal is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const state = stubLoopState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, ctrl.signal, stubCallbacks())).toBe('skip');
    expect(checkCompletionGate).not.toHaveBeenCalled();
  });

  it('skips in plan mode even when edits are present', async () => {
    const state = stubLoopState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(
      await maybeInjectCompletionGate(state, stubConfig(), { approvalMode: 'plan' }, signal, stubCallbacks()),
    ).toBe('skip');
  });

  it('skips when completionGateEnabled is false', async () => {
    const state = stubLoopState({
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
    const state = stubLoopState({ gateState: stubGateState() }); // editedFiles starts empty
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks())).toBe('skip');
  });

  it('skips + warns when gate has already injected MAX_GATE_INJECTIONS times', async () => {
    const warn = vi.fn();
    const state = stubLoopState({
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
    const state = stubLoopState({
      logger: { warn, info: vi.fn() } as unknown as LoopState['logger'],
      gateState: { editedFiles: new Set(), gateInjections: 2 } as unknown as LoopState['gateState'],
    });
    await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks());
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips when checkCompletionGate returns no findings', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([]);
    const state = stubLoopState({
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    expect(await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks())).toBe('skip');
    expect(checkCompletionGate).toHaveBeenCalledOnce();
  });
});

describe('maybeInjectCompletionGate — MCP mutation-verify gate', () => {
  const options: AgentOptions = {};
  const signal = new AbortController().signal;

  // A queued mockReturnValueOnce survives a test that never calls the builder
  // (e.g. the disabled-gate path) and would leak into unrelated suites below.
  afterEach(() => {
    vi.mocked(buildMcpMutationVerifyReprompt).mockReset().mockReturnValue(null);
  });

  it('fires "injected" + pushes the reprompt when unverified MCP mutations exist', async () => {
    vi.mocked(buildMcpMutationVerifyReprompt).mockReturnValueOnce('⛔ Unverified external write(s).');
    const gs = stubGateState();
    const state = stubLoopState({ gateState: gs });
    const out = await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks());
    expect(out).toBe('injected');
    expect((gs as unknown as { mcpMutationRepromptFired: boolean }).mcpMutationRepromptFired).toBe(true);
    expect(
      state.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('Unverified external')),
    ).toBe(true);
  });

  it('fires at most once per run', async () => {
    vi.mocked(buildMcpMutationVerifyReprompt).mockReturnValue('⛔ Unverified external write(s).');
    const gs = { ...stubGateState(), mcpMutationRepromptFired: true } as unknown as LoopState['gateState'];
    const state = stubLoopState({ gateState: gs });
    const out = await maybeInjectCompletionGate(state, stubConfig(), options, signal, stubCallbacks());
    expect(out).toBe('skip');
  });

  it('does not fire when the completion gate is disabled', async () => {
    vi.mocked(buildMcpMutationVerifyReprompt).mockReturnValueOnce('⛔ Unverified external write(s).');
    const state = stubLoopState({ gateState: stubGateState() });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ completionGateEnabled: false }),
      options,
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('skip');
  });
});

describe('maybeInjectCompletionGate — injection path', () => {
  it('returns "injected" + pushes a user message when findings are present', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([
      { kind: 'unverified-edit', file: 'a.ts', hint: 'run tests' },
    ] as unknown as Awaited<ReturnType<typeof checkCompletionGate>>);
    const state = stubLoopState({
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
    const state = stubLoopState({
      logger: { info, warn: vi.fn() } as unknown as LoopState['logger'],
      gateState: { editedFiles: new Set(['a.ts']), gateInjections: 0 } as unknown as LoopState['gateState'],
    });
    await maybeInjectCompletionGate(state, stubConfig(), {}, new AbortController().signal, stubCallbacks());
    // The injection summary is logged (alongside the syntax gate's own
    // observability line for the non-checkable a.ts edit).
    expect(info.mock.calls.some((c) => String(c[0]).includes('#1/2'))).toBe(true);
  });
});

describe('maybeInjectCompletionGate — change-impact gate', () => {
  const signal = new AbortController().signal;

  afterEach(() => setSymbolGraph(null));

  // auth.ts exports requireAuth; route.ts imports + calls it (a resolved
  // cross-file dependent).
  function graphWithDependents(): SymbolGraph {
    const g = new SymbolGraph();
    g.addFile(
      'src/auth.ts',
      [
        {
          name: 'requireAuth',
          qualifiedName: 'requireAuth',
          type: 'function',
          filePath: 'src/auth.ts',
          startLine: 0,
          endLine: 4,
          exported: true,
        },
      ],
      [],
      'h1',
    );
    g.addFile(
      'src/route.ts',
      [
        {
          name: 'handleLogin',
          qualifiedName: 'handleLogin',
          type: 'function',
          filePath: 'src/route.ts',
          startLine: 0,
          endLine: 6,
          exported: true,
        },
      ],
      [{ fromFile: 'src/route.ts', toFile: 'src/auth', importedNames: ['requireAuth'] }],
      'h2',
      [{ callerFile: 'src/route.ts', callerName: 'handleLogin', calleeName: 'requireAuth', line: 3 }],
    );
    return g;
  }

  function gateState(overrides: Record<string, unknown> = {}) {
    return {
      editedFiles: new Set(['src/auth.ts']),
      gateInjections: 0,
      projectTestsPassed: false,
      passingTestFiles: new Set<string>(),
      testsRunForFiles: new Set<string>(),
      ...overrides,
    } as unknown as LoopState['gateState'];
  }

  it('blocks once when enabled, an edited exported symbol has unverified dependents', async () => {
    setSymbolGraph(graphWithDependents());
    const gs = gateState();
    const state = stubLoopState({ gateState: gs });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ impactGateEnabled: true }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('injected');
    expect((gs as unknown as { impactGateInjections: number }).impactGateInjections).toBe(1);
    expect(
      state.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('cross-file dependents')),
    ).toBe(true);
  });

  it('does not block when the setting is off (advisory only → falls through to skip)', async () => {
    setSymbolGraph(graphWithDependents());
    const state = stubLoopState({ gateState: gateState() });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ impactGateEnabled: false }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('skip');
  });

  it('does not block when a test already passed this run', async () => {
    setSymbolGraph(graphWithDependents());
    const state = stubLoopState({ gateState: gateState({ passingTestFiles: new Set(['src/auth.test.ts']) }) });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ impactGateEnabled: true }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('skip');
  });

  it('does not block twice (bounded to one injection)', async () => {
    setSymbolGraph(graphWithDependents());
    const state = stubLoopState({ gateState: gateState({ impactGateInjections: 1 }) });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ impactGateEnabled: true }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('skip');
  });
});

describe('maybeInjectCompletionGate — numerical-contract gate', () => {
  const signal = new AbortController().signal;
  afterEach(() => setSymbolGraph(null));

  const SRC = [
    'def orient(p: np.ndarray) -> np.ndarray:',
    '    return p[::-1]',
    '',
    'def checked(p: np.ndarray) -> np.ndarray:',
    '    assert p.shape == (3,)',
    '    return p',
  ].join('\n');

  function pyGraph(src = SRC): SymbolGraph {
    const g = new SymbolGraph();
    const sym = (name: string, s: number, e: number) => ({
      name,
      qualifiedName: name,
      type: 'function' as const,
      filePath: 'geo.py',
      startLine: s,
      endLine: e,
      exported: true,
    });
    const use = (name: string, role: 'param' | 'return') => ({
      userFile: 'geo.py',
      userName: name,
      typeName: 'ndarray',
      role,
      line: 1,
    });
    g.addFile(
      'geo.py',
      [sym('orient', 0, 1), sym('checked', 3, 5)],
      [],
      'h1',
      [],
      [],
      [use('orient', 'param'), use('orient', 'return'), use('checked', 'param')],
    );
    g.setFileContent('geo.py', src);
    return g;
  }

  function gs(overrides: Record<string, unknown> = {}) {
    // syntaxGateInjections: 2 disables the real parse-check shell for the .py
    // edited file (it would otherwise spawn py_compile and time out in tests).
    return {
      editedFiles: new Set(['geo.py']),
      gateInjections: 0,
      syntaxGateInjections: 2,
      ...overrides,
    } as unknown as LoopState['gateState'];
  }

  it('blocks once when enabled and an edited kernel lacks a contract', async () => {
    setSymbolGraph(pyGraph());
    const state = stubLoopState({ gateState: gs() });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ numericalContractGateEnabled: true }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('injected');
    expect(state.messages.some((m) => JSON.stringify(m.content).includes('numerical-contract issues'))).toBe(true);
  });

  it('blocks on a shape-contract conflict even when contracts are present', async () => {
    const g = new SymbolGraph();
    const sym = (name: string, s: number, e: number) => ({
      name,
      qualifiedName: name,
      type: 'function' as const,
      filePath: 'geo.py',
      startLine: s,
      endLine: e,
      exported: true,
    });
    g.addFile(
      'geo.py',
      [sym('f', 0, 2)],
      [],
      'h1',
      [],
      [],
      [{ userFile: 'geo.py', userName: 'f', typeName: 'NDArray', role: 'param', line: 1 }],
    );
    // annotation says (N, 3); the assertion says (N, 4) — a provable dim conflict.
    g.setFileContent(
      'geo.py',
      ['def f(a: NDArray[Shape["N, 3"]]) -> None:', '    assert a.shape == (N, 4)', '    return None'].join('\n'),
    );
    setSymbolGraph(g);
    const state = stubLoopState({ gateState: gs() });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ numericalContractGateEnabled: true }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('injected');
    expect(state.messages.some((m) => JSON.stringify(m.content).includes('Shape-contract conflicts'))).toBe(true);
  });

  it('does not block when the setting is off (advisory only → skip)', async () => {
    setSymbolGraph(pyGraph());
    const state = stubLoopState({ gateState: gs() });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ numericalContractGateEnabled: false }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('skip');
  });

  it('does not fire when every edited kernel already has a contract', async () => {
    // Only `checked` has a contract; drop `orient` so nothing is uncontracted.
    const g = new SymbolGraph();
    g.addFile(
      'geo.py',
      [
        {
          name: 'checked',
          qualifiedName: 'checked',
          type: 'function',
          filePath: 'geo.py',
          startLine: 0,
          endLine: 2,
          exported: true,
        },
      ],
      [],
      'h1',
      [],
      [],
      [{ userFile: 'geo.py', userName: 'checked', typeName: 'ndarray', role: 'param', line: 1 }],
    );
    g.setFileContent(
      'geo.py',
      ['def checked(p: np.ndarray):', '    assert p.shape == (3,)', '    return p'].join('\n'),
    );
    setSymbolGraph(g);
    const state = stubLoopState({ gateState: gs() });
    const out = await maybeInjectCompletionGate(
      state,
      stubConfig({ numericalContractGateEnabled: true }),
      {},
      signal,
      stubCallbacks(),
    );
    expect(out).toBe('skip');
  });
});
