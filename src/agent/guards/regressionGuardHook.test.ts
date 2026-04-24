import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace } from 'vscode';
import type { LoopState } from '../loop/state.js';
import type { HookContext } from '../loop/policyHook.js';
import type { ToolUseContentBlock, ChatMessage } from '../../ollama/types.js';

// Mock ShellSession so these tests don't actually spawn shells or
// depend on bash/zsh being present. Each test configures what the
// session's execute() returns.
const shellExecuteMock = vi.fn();
vi.mock('../../terminal/shellSession.js', () => ({
  ShellSession: class {
    execute = shellExecuteMock;
    dispose = vi.fn();
  },
}));

// Mock checkWorkspaceConfigTrust so buildRegressionGuardHooks tests
// can exercise both the trusted and blocked paths without hitting
// the real per-session trust cache.
const trustMock = vi.fn();
vi.mock('../../config/workspaceTrust.js', () => ({
  checkWorkspaceConfigTrust: (...args: unknown[]) => trustMock(...args),
}));

import { RegressionGuardHook, buildRegressionGuardHooks, validateGuard } from './regressionGuardHook.js';

// ---------------------------------------------------------------------------
// Small helpers for assembling the HookContext / LoopState shapes that
// afterToolResults / onEmptyResponse expect.
// ---------------------------------------------------------------------------

function makeState(messages: ChatMessage[] = []): LoopState {
  return { messages, logger: { warn: vi.fn() } } as unknown as LoopState;
}

function makeCtx(pendingToolUses: ToolUseContentBlock[] = []): HookContext {
  return {
    client: {} as never,
    config: {} as never,
    options: {},
    signal: new AbortController().signal,
    callbacks: { onText: vi.fn() } as never,
    runId: 'test-run-id',
    pendingToolUses,
  };
}

function writeFileToolUse(path: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 't1', name: 'write_file', input: { path, content: 'x' } } as ToolUseContentBlock;
}

function grepToolUse(query: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 't2', name: 'grep', input: { query } } as ToolUseContentBlock;
}

describe('validateGuard', () => {
  it('accepts a minimal well-formed guard', () => {
    const g = validateGuard({ name: 'physics', command: 'python v.py', trigger: 'pre-completion' });
    expect(g).not.toBeNull();
    expect(g!.name).toBe('physics');
    expect(g!.command).toBe('python v.py');
    expect(g!.trigger).toBe('pre-completion');
  });

  it('copies optional fields through when types match', () => {
    const g = validateGuard({
      name: 'g',
      command: 'c',
      trigger: 'post-write',
      blocking: false,
      timeoutMs: 1000,
      scope: ['src/**'],
      maxAttempts: 3,
      workingDir: '/tmp',
    });
    expect(g!.blocking).toBe(false);
    expect(g!.timeoutMs).toBe(1000);
    expect(g!.scope).toEqual(['src/**']);
    expect(g!.maxAttempts).toBe(3);
    expect(g!.workingDir).toBe('/tmp');
  });

  it('rejects missing name', () => {
    expect(validateGuard({ command: 'c', trigger: 'post-turn' })).toBeNull();
  });

  it('rejects empty name', () => {
    expect(validateGuard({ name: '   ', command: 'c', trigger: 'post-turn' })).toBeNull();
  });

  it('rejects missing command', () => {
    expect(validateGuard({ name: 'g', trigger: 'post-turn' })).toBeNull();
  });

  it('rejects invalid trigger', () => {
    expect(validateGuard({ name: 'g', command: 'c', trigger: 'on-save' })).toBeNull();
  });

  it('drops optional fields with wrong types rather than failing the whole entry', () => {
    const g = validateGuard({
      name: 'g',
      command: 'c',
      trigger: 'post-turn',
      blocking: 'yes', // wrong type
      timeoutMs: -5, // non-positive
      scope: 'not-an-array',
      maxAttempts: 0, // non-positive
    });
    expect(g).not.toBeNull();
    expect(g!.blocking).toBeUndefined();
    expect(g!.timeoutMs).toBeUndefined();
    expect(g!.scope).toBeUndefined();
    expect(g!.maxAttempts).toBeUndefined();
  });
});

describe('RegressionGuardHook.afterToolResults', () => {
  beforeEach(() => {
    shellExecuteMock.mockReset();
    trustMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('post-write trigger', () => {
    it('skips when the turn has no file-mutation tool uses', async () => {
      const hook = new RegressionGuardHook({
        name: 'physics',
        command: 'python v.py',
        trigger: 'post-write',
      });
      const state = makeState();
      await hook.afterToolResults(state, makeCtx([grepToolUse('needle')]));
      expect(shellExecuteMock).not.toHaveBeenCalled();
      expect(state.messages).toHaveLength(0);
    });

    it('runs when at least one write_file tool_use is present and exit is 0 (no injection)', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 0, stdout: 'ok', timedOut: false });
      const hook = new RegressionGuardHook({
        name: 'g',
        command: 'c',
        trigger: 'post-write',
      });
      const state = makeState();
      await hook.afterToolResults(state, makeCtx([writeFileToolUse('src/foo.ts')]));
      expect(shellExecuteMock).toHaveBeenCalledOnce();
      expect(state.messages).toHaveLength(0);
    });

    it('injects a synthetic user message when blocking and exit is non-zero', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 2, stdout: 'fatal: invariant violated', timedOut: false });
      const hook = new RegressionGuardHook({
        name: 'physics',
        command: 'python v.py',
        trigger: 'post-write',
      });
      const state = makeState();
      const result = await hook.afterToolResults(state, makeCtx([writeFileToolUse('src/physics/sim.py')]));
      expect(result).toMatchObject({ mutated: true });
      expect(state.messages).toHaveLength(1);
      const msg = state.messages[0];
      expect(msg.role).toBe('user');
      expect(msg.content as string).toContain('`physics`');
      expect(msg.content as string).toContain('exit 2');
      expect(msg.content as string).toContain('invariant violated');
    });

    it('surfaces a warning instead of injecting when blocking: false', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 1, stdout: 'soft fail', timedOut: false });
      const hook = new RegressionGuardHook({
        name: 'perf-budget',
        command: 'bundle-size',
        trigger: 'post-write',
        blocking: false,
      });
      const state = makeState();
      const ctx = makeCtx([writeFileToolUse('src/bundle.ts')]);
      const onTextSpy = ctx.callbacks.onText as ReturnType<typeof vi.fn>;
      const result = await hook.afterToolResults(state, ctx);
      expect(result).toBeUndefined();
      expect(state.messages).toHaveLength(0);
      expect(onTextSpy).toHaveBeenCalledWith(expect.stringContaining('advisory'));
    });
  });

  describe('post-turn trigger', () => {
    it('fires even when no mutation tools ran', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
      const hook = new RegressionGuardHook({ name: 'g', command: 'c', trigger: 'post-turn' });
      await hook.afterToolResults(makeState(), makeCtx([grepToolUse('x')]));
      expect(shellExecuteMock).toHaveBeenCalledOnce();
    });
  });

  describe('pre-completion trigger', () => {
    it('does NOT fire on afterToolResults', async () => {
      const hook = new RegressionGuardHook({ name: 'g', command: 'c', trigger: 'pre-completion' });
      await hook.afterToolResults(makeState(), makeCtx([writeFileToolUse('src/x.ts')]));
      expect(shellExecuteMock).not.toHaveBeenCalled();
    });

    it('fires on onEmptyResponse', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
      const hook = new RegressionGuardHook({ name: 'g', command: 'c', trigger: 'pre-completion' });
      await hook.onEmptyResponse(makeState(), makeCtx([]));
      expect(shellExecuteMock).toHaveBeenCalledOnce();
    });

    it('blocks completion by injecting a message when the pre-completion guard fails', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 1, stdout: 'not ready', timedOut: false });
      const hook = new RegressionGuardHook({ name: 'g', command: 'c', trigger: 'pre-completion' });
      const state = makeState();
      const result = await hook.onEmptyResponse(state, makeCtx([]));
      expect(result).toMatchObject({ mutated: true });
      expect(state.messages).toHaveLength(1);
    });
  });

  describe('scope glob filtering', () => {
    it('runs only when a touched file matches the scope', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
      const hook = new RegressionGuardHook({
        name: 'physics',
        command: 'c',
        trigger: 'post-write',
        scope: ['src/physics/**'],
      });
      await hook.afterToolResults(makeState(), makeCtx([writeFileToolUse('src/physics/sim.py')]));
      expect(shellExecuteMock).toHaveBeenCalledOnce();
    });

    it('skips when no touched file matches the scope', async () => {
      const hook = new RegressionGuardHook({
        name: 'physics',
        command: 'c',
        trigger: 'post-write',
        scope: ['src/physics/**'],
      });
      await hook.afterToolResults(makeState(), makeCtx([writeFileToolUse('src/ui/chat.ts')]));
      expect(shellExecuteMock).not.toHaveBeenCalled();
    });
  });

  describe('attempt budget', () => {
    it('emits a one-time escalation message after maxAttempts consecutive failures and stops running', async () => {
      shellExecuteMock.mockResolvedValue({ exitCode: 1, stdout: 'still broken', timedOut: false });
      const hook = new RegressionGuardHook({
        name: 'g',
        command: 'c',
        trigger: 'post-turn',
        maxAttempts: 2,
      });
      const state = makeState();

      // Two failing runs bring attempts to 2.
      await hook.afterToolResults(state, makeCtx([]));
      await hook.afterToolResults(state, makeCtx([]));
      expect(shellExecuteMock).toHaveBeenCalledTimes(2);
      // Both produced blocking injections.
      expect(state.messages).toHaveLength(2);

      // Third call: attempts === maxAttempts, so the guard no longer
      // executes the command; it emits a single escalation message.
      await hook.afterToolResults(state, makeCtx([]));
      expect(shellExecuteMock).toHaveBeenCalledTimes(2); // not called again
      expect(state.messages).toHaveLength(3);
      expect(state.messages[2].content as string).toContain('exceeded 2 failed attempts');
    });

    it('resets the attempt counter after a successful run', async () => {
      const hook = new RegressionGuardHook({
        name: 'g',
        command: 'c',
        trigger: 'post-turn',
        maxAttempts: 2,
      });
      const state = makeState();

      shellExecuteMock.mockResolvedValue({ exitCode: 1, stdout: 'fail', timedOut: false });
      await hook.afterToolResults(state, makeCtx([]));
      expect(state.messages).toHaveLength(1);

      // Success: attempts resets.
      shellExecuteMock.mockResolvedValue({ exitCode: 0, stdout: '', timedOut: false });
      await hook.afterToolResults(state, makeCtx([]));
      expect(state.messages).toHaveLength(1); // no new injection

      // Failing again should still work — not immediately fall through
      // to escalation — because the counter reset.
      shellExecuteMock.mockResolvedValue({ exitCode: 1, stdout: 'fail', timedOut: false });
      await hook.afterToolResults(state, makeCtx([]));
      expect(state.messages).toHaveLength(2);
    });
  });
});

describe('buildRegressionGuardHooks', () => {
  beforeEach(() => {
    trustMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubConfig(overrides: Record<string, unknown>): void {
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string, defaultValue?: T) => (key in overrides ? (overrides[key] as T) : (defaultValue as T)),
      inspect: () => ({}),
      update: async () => {},
      has: () => false,
    } as never);
  }

  it('returns empty when sidecar.regressionGuards is empty', async () => {
    stubConfig({ 'regressionGuards.mode': 'strict', regressionGuards: [] });
    const hooks = await buildRegressionGuardHooks();
    expect(hooks).toEqual([]);
    expect(trustMock).not.toHaveBeenCalled();
  });

  it('returns empty when the mode is off', async () => {
    stubConfig({
      'regressionGuards.mode': 'off',
      regressionGuards: [{ name: 'g', command: 'c', trigger: 'post-turn' }],
    });
    const hooks = await buildRegressionGuardHooks();
    expect(hooks).toEqual([]);
    expect(trustMock).not.toHaveBeenCalled();
  });

  it('returns empty when the user blocks the trust prompt', async () => {
    stubConfig({
      'regressionGuards.mode': 'strict',
      regressionGuards: [{ name: 'g', command: 'c', trigger: 'post-turn' }],
    });
    trustMock.mockResolvedValueOnce('blocked');
    const hooks = await buildRegressionGuardHooks();
    expect(hooks).toEqual([]);
  });

  it('returns one hook per valid guard when trust is granted', async () => {
    stubConfig({
      'regressionGuards.mode': 'strict',
      regressionGuards: [
        { name: 'a', command: 'c1', trigger: 'post-write' },
        { name: 'b', command: 'c2', trigger: 'post-turn' },
        { command: 'c3', trigger: 'post-turn' }, // invalid — missing name; dropped
      ],
    });
    trustMock.mockResolvedValueOnce('trusted');
    const hooks = await buildRegressionGuardHooks();
    expect(hooks).toHaveLength(2);
    expect(hooks[0].name).toBe('regressionGuard:a');
    expect(hooks[1].name).toBe('regressionGuard:b');
  });

  it('forces blocking: false on every guard when mode is warn', async () => {
    stubConfig({
      'regressionGuards.mode': 'warn',
      regressionGuards: [{ name: 'strict-normally', command: 'c', trigger: 'post-turn', blocking: true }],
    });
    trustMock.mockResolvedValueOnce('trusted');

    const hooks = await buildRegressionGuardHooks();
    expect(hooks).toHaveLength(1);

    // Exercise the hook with a failing command — should NOT inject a
    // message because warn mode flipped blocking off.
    shellExecuteMock.mockResolvedValue({ exitCode: 1, stdout: 'warn-only', timedOut: false });
    const state = makeState();
    const ctx = makeCtx([]);
    const onTextSpy = ctx.callbacks.onText as ReturnType<typeof vi.fn>;
    await hooks[0].afterToolResults!(state, ctx);
    expect(state.messages).toHaveLength(0);
    expect(onTextSpy).toHaveBeenCalledWith(expect.stringContaining('advisory'));
  });
});
