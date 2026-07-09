import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubLoopState } from './testHelpers.js';

// ---------------------------------------------------------------------------
// Tests for executeToolUses.ts (loop helper hardening).
//
// `executeToolUses` dispatches each tool_use to one of three paths
// based on tool name:
//   - 'spawn_agent'    → spawnSubAgent (recursive, charges parent budget)
//   - 'delegate_task'  → runLocalWorker (free local model, doesn't charge)
//   - anything else    → executeTool (normal dispatch)
//
// Plus pre-dispatch budget check (checkToolBudget) and post-execution
// memory/recorder/onToolResult callbacks. Tests mock each downstream
// collaborator and drive through the routing + result-shape behavior.
// Rejected promises must become synthetic error results so the
// toolResults array stays aligned with pendingToolUses.
// ---------------------------------------------------------------------------

vi.mock('../executor.js', () => ({
  executeTool: vi.fn(),
}));
vi.mock('../subagent.js', () => ({
  spawnSubAgent: vi.fn(),
}));
vi.mock('../localWorker.js', () => ({
  runLocalWorker: vi.fn(),
}));
vi.mock('./toolBudget.js', () => ({
  checkToolBudget: vi.fn(() => null),
  recordToolUse: vi.fn(),
}));

import { executeToolUses } from './executeToolUses.js';
import { executeTool } from '../executor.js';
import { spawnSubAgent } from '../subagent.js';
import { runLocalWorker } from '../localWorker.js';
import { checkToolBudget } from './toolBudget.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

function stubCallbacks() {
  // Avoid a typed return annotation — vi.fn() is too wide to unify
  // with AgentCallbacks' strict method signatures, and the tests only
  // need the observable vi.fn surface (.mock.calls, .toHaveBeenCalledWith).
  const cb = {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    onMemory: vi.fn(),
    onToolChainRecord: vi.fn(),
  };
  return cb as typeof cb & AgentCallbacks;
}

function use(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
}

beforeEach(() => {
  vi.mocked(executeTool).mockReset();
  vi.mocked(spawnSubAgent).mockReset();
  vi.mocked(runLocalWorker).mockReset();
  vi.mocked(checkToolBudget).mockReset().mockReturnValue(null);
});

describe('executeToolUses — dispatch routing', () => {
  it('routes non-special tool names to executeTool', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu-read_file',
      content: 'file content',
      is_error: false,
    });
    const state = stubLoopState();
    const cb = stubCallbacks();
    const results = await executeToolUses(
      state,
      [use('read_file', { path: 'a.ts' })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(executeTool).toHaveBeenCalledOnce();
    expect(spawnSubAgent).not.toHaveBeenCalled();
    expect(runLocalWorker).not.toHaveBeenCalled();
    expect(results[0].content).toBe('file content');
  });

  it('routes spawn_agent to spawnSubAgent and credits charsConsumed to state.totalChars', async () => {
    vi.mocked(spawnSubAgent).mockResolvedValueOnce({
      id: 'sub-1',
      task: 'research FFT',
      output: 'sub-agent result',
      success: true,
      charsConsumed: 5000,
    });
    const state = stubLoopState({ totalChars: 1000 });
    const cb = stubCallbacks();
    const results = await executeToolUses(
      state,
      [use('spawn_agent', { task: 'research FFT' })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(spawnSubAgent).toHaveBeenCalledOnce();
    expect(state.totalChars).toBe(6000); // 1000 + 5000
    expect(results[0].content).toBe('sub-agent result');
    expect(results[0].is_error).toBe(false);
  });

  it('returns an error tool_result when spawn_agent succeeds:false', async () => {
    vi.mocked(spawnSubAgent).mockResolvedValueOnce({
      id: 'sub-2',
      task: 'x',
      output: 'hit an error',
      success: false,
      charsConsumed: 100,
    });
    const results = await executeToolUses(
      stubLoopState(),
      [use('spawn_agent', { task: 'x' })],
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
    );
    expect(results[0].is_error).toBe(true);
  });

  it('routes delegate_task to runLocalWorker and does NOT charge state.totalChars', async () => {
    vi.mocked(runLocalWorker).mockResolvedValueOnce({
      output: 'worker did the thing',
      success: true,
      charsConsumed: 800,
      model: 'ollama/qwen2.5:7b',
    });
    const state = stubLoopState({ totalChars: 1000 });
    const cb = stubCallbacks();
    await executeToolUses(
      state,
      [use('delegate_task', { task: 'read big file' })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(runLocalWorker).toHaveBeenCalledOnce();
    expect(state.totalChars).toBe(1000); // UNCHARGED
  });
});

describe('executeToolUses — budget check short-circuit', () => {
  it('skips execution entirely and returns an error result when checkToolBudget returns a message', async () => {
    vi.mocked(checkToolBudget).mockReturnValueOnce('read_file exceeded per-turn limit (3/3)');
    const cb = stubCallbacks();
    const results = await executeToolUses(
      stubLoopState(),
      [use('read_file')],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain('exceeded');
    expect(cb.onToolResult).toHaveBeenCalledWith(
      'read_file',
      expect.stringContaining('exceeded'),
      true,
      'tu-read_file',
    );
  });
});

describe('executeToolUses — parallel execution + error promotion', () => {
  it('runs every tool_use in parallel (Promise.allSettled)', async () => {
    let resolveFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => (resolveFirst = resolve));
    vi.mocked(executeTool)
      .mockImplementationOnce(async () => {
        resolveFirst!();
        // Hold first until second has clearly started.
        await new Promise((r) => setTimeout(r, 10));
        return { type: 'tool_result', tool_use_id: 'tu-a', content: 'a', is_error: false };
      })
      .mockImplementationOnce(async () => {
        await firstStarted; // verifies parallel — second starts while first is mid-flight
        return { type: 'tool_result', tool_use_id: 'tu-b', content: 'b', is_error: false };
      });

    const results = await executeToolUses(
      stubLoopState(),
      [use('a'), use('b')],
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
    );
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('a');
    expect(results[1].content).toBe('b');
  });

  it('promotes a rejected promise into a synthetic error tool_result (array alignment preserved)', async () => {
    vi.mocked(executeTool)
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ type: 'tool_result', tool_use_id: 'tu-b', content: 'b', is_error: false });

    const state = stubLoopState();
    const cb = stubCallbacks();
    const results = await executeToolUses(
      state,
      [use('a'), use('b')],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(results).toHaveLength(2);
    expect(results[0].is_error).toBe(true);
    expect(results[0].content).toContain('disk full');
    expect(results[0].tool_use_id).toBe('tu-a');
    expect(results[1].content).toBe('b');
    // onToolResult fired for the synthetic error
    expect(cb.onToolResult).toHaveBeenCalledWith('a', expect.stringContaining('disk full'), true, 'tu-a');
  });

  it('aborts batchSignal when one tool throws — sibling executorContext.signal is aborted', async () => {
    // Tool A rejects immediately, which fires batchAbort.abort() inside executeToolUses.
    // Tool B captures the signal reference from its executorContext; since batchSignal is
    // shared by reference, it must read as aborted by the time tool B inspects it.
    let capturedSignal: AbortSignal | undefined;

    vi.mocked(executeTool)
      .mockImplementationOnce(() => Promise.reject(new Error('tool A failed')))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementationOnce((_toolUse: unknown, opts: any) => {
        capturedSignal = opts.executorContext.signal as AbortSignal;
        // Resolve after a tick so batchAbort.abort() has fired first.
        return new Promise((resolve) =>
          setTimeout(() => resolve({ type: 'tool_result', tool_use_id: 'tu-b', content: 'ok', is_error: false }), 10),
        );
      });

    await executeToolUses(
      stubLoopState(),
      [use('a'), use('b')],
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

describe('executeToolUses — memory + chain recording', () => {
  it('records a "pattern" memory on successful tool execution', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu-read_file',
      content: 'ok',
      is_error: false,
    });
    const cb = stubCallbacks();
    await executeToolUses(
      stubLoopState(),
      [use('read_file', { path: 'a.ts' })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(cb.onMemory).toHaveBeenCalledWith('pattern', 'tool:read_file', expect.stringContaining('works well'));
    expect(cb.onToolChainRecord).toHaveBeenCalledWith('read_file', true);
  });

  it('records a "failure" memory when the tool fails', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu-edit_file',
      content: 'permission denied',
      is_error: true,
    });
    const cb = stubCallbacks();
    await executeToolUses(
      stubLoopState(),
      [use('edit_file', { path: 'a.ts' })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(cb.onMemory).toHaveBeenCalledWith('failure', 'tool:edit_file', expect.stringContaining('can fail'));
    expect(cb.onToolChainRecord).toHaveBeenCalledWith('edit_file', false);
  });
});

describe('onPlanUpdate checkpointing hook (S1)', () => {
  it('fires once post-dispatch when update_plan changed the plan', async () => {
    vi.mocked(executeTool).mockImplementationOnce(async (toolUse, _opts) => {
      // Simulate the update_plan executor mutating the shared ref.
      state.planRef.plan = { steps: ['a', 'b'], current: 1 };
      return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Plan updated', is_error: false };
    });
    const state = stubLoopState();
    const onPlanUpdate = vi.fn();
    const cb = { ...stubCallbacks(), onPlanUpdate };
    await executeToolUses(
      state,
      [use('update_plan', { steps: ['a', 'b'] })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(onPlanUpdate).toHaveBeenCalledTimes(1);
    expect(onPlanUpdate).toHaveBeenCalledWith({ steps: ['a', 'b'], current: 1 });
  });

  it('does not fire when no tool touched the plan', async () => {
    vi.mocked(executeTool).mockResolvedValueOnce({
      type: 'tool_result',
      tool_use_id: 'tu-read_file',
      content: 'x',
      is_error: false,
    });
    const state = stubLoopState();
    const onPlanUpdate = vi.fn();
    const cb = { ...stubCallbacks(), onPlanUpdate };
    await executeToolUses(
      state,
      [use('read_file', { path: 'a.ts' })],
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
    );
    expect(onPlanUpdate).not.toHaveBeenCalled();
  });
});
