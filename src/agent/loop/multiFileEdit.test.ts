import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for multiFileEdit.ts (v0.65 chunk 4.3a).
//
// executeMultiFilePlan walks an EditPlan as a DAG and dispatches each
// node through executeOneToolUse (mocked here). Tests pin:
//   - result alignment with pendingToolUses (1:1 by index)
//   - layer ordering: earlier layers finish before later ones start
//   - bounded parallelism: within a layer, at most maxParallel concurrent
//   - duplicate same-path pending writes get merged-by-plan synthetic results
//   - planner-invented paths (in plan but not in pending) are skipped
//     + logged, and the matching pending writes surface as "planner
//     omitted" error results
//   - rejected task → synthetic error result (doesn't crash the pool)
//   - abort mid-layer stops dispatch of later layers
// ---------------------------------------------------------------------------

vi.mock('./executeToolUses.js', () => ({
  executeOneToolUse: vi.fn(),
}));

import { executeMultiFilePlan } from './multiFileEdit.js';
import { executeOneToolUse } from './executeToolUses.js';
import type { LoopState } from './state.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { EditPlan } from '../editPlan.js';

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    taskId: 'test-task',
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: { info: vi.fn(), warn: vi.fn() } as unknown as LoopState['logger'],
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
    currentEditPlan: null,
    ...overrides,
  };
}

function stubCallbacks() {
  const texts: string[] = [];
  const cb = {
    texts,
    onText: (t: string) => texts.push(t),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    onEditPlanProgress: vi.fn(),
  };
  return cb as typeof cb & AgentCallbacks;
}

function tu(path: string, id?: string): ToolUseContentBlock {
  return { type: 'tool_use', id: id ?? `tu-${path}`, name: 'write_file', input: { path, content: 'x' } };
}

function result(tuId: string, content: string): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: tuId, content, is_error: false };
}

beforeEach(() => {
  vi.mocked(executeOneToolUse).mockReset();
});

describe('executeMultiFilePlan — result alignment', () => {
  it('returns a result per pending tool_use, aligned 1:1 by index', async () => {
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) =>
      result(pendingTu.id, `wrote-${pendingTu.input.path}`),
    );
    const pending = [tu('a.ts'), tu('b.ts'), tu('c.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: ['a.ts'] },
        { path: 'c.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    const results = await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      8,
    );
    expect(results).toHaveLength(3);
    expect(results[0].tool_use_id).toBe('tu-a.ts');
    expect(results[1].tool_use_id).toBe('tu-b.ts');
    expect(results[2].tool_use_id).toBe('tu-c.ts');
    expect(results[0].content).toBe('wrote-a.ts');
  });
});

describe('executeMultiFilePlan — DAG ordering', () => {
  it('runs earlier layers before later ones: dependent writes do not start until deps finish', async () => {
    const events: string[] = [];
    let aResolve!: () => void;
    const aGate = new Promise<void>((r) => (aResolve = r));
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => {
      const p = pendingTu.input.path as string;
      if (p === 'a.ts') {
        events.push('a-start');
        await aGate;
        events.push('a-end');
        return result(pendingTu.id, 'a');
      }
      events.push(`${p}-start`);
      events.push(`${p}-end`);
      return result(pendingTu.id, p);
    });

    const pending = [tu('a.ts'), tu('b.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: ['a.ts'] },
      ],
    };
    const p = executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      8,
    );
    // Wait a tick — b should not have started yet because a is gated.
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['a-start']);
    aResolve();
    await p;
    expect(events).toEqual(['a-start', 'a-end', 'b.ts-start', 'b.ts-end']);
  });

  it('runs independent writes in the same layer concurrently', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return result(pendingTu.id, 'ok');
    });
    const pending = [tu('a.ts'), tu('b.ts'), tu('c.ts'), tu('d.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'c.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'd.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      4,
    );
    expect(peakInFlight).toBe(4);
  });
});

describe('executeMultiFilePlan — bounded parallelism', () => {
  it('caps in-flight at maxParallel even when layer width exceeds it', async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return result(pendingTu.id, 'ok');
    });
    // 6 independent writes, cap=2 → peak should be 2
    const pending = Array.from({ length: 6 }, (_, i) => tu(`f${i}.ts`));
    const plan: EditPlan = {
      edits: pending.map((p) => ({ path: p.input.path as string, op: 'edit', rationale: '', dependsOn: [] })),
    };
    await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      2,
    );
    expect(peak).toBe(2);
  });
});

describe('executeMultiFilePlan — same-path duplicates', () => {
  it('executes the first tool_use for a path; subsequent dupes get a merged-by-plan synthetic result', async () => {
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => result(pendingTu.id, 'wrote'));
    const pending = [tu('a.ts', 'tu1'), tu('a.ts', 'tu2'), tu('b.ts', 'tu3')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    const results = await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      8,
    );
    expect(results).toHaveLength(3);
    expect(results[0].tool_use_id).toBe('tu1');
    expect(results[0].content).toBe('wrote');
    expect(results[1].tool_use_id).toBe('tu2');
    expect(String(results[1].content)).toContain('Merged by edit plan');
    expect(results[1].is_error).toBe(false);
    expect(results[2].tool_use_id).toBe('tu3');
    expect(results[2].content).toBe('wrote');
    // executeOneToolUse called exactly twice (a.ts + b.ts), not 3 times.
    expect(executeOneToolUse).toHaveBeenCalledTimes(2);
  });
});

describe('executeMultiFilePlan — planner invented path', () => {
  it('skips plan entries whose path is not in pending, logging a warning', async () => {
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => result(pendingTu.id, 'ok'));
    const pending = [tu('a.ts')];
    const state = stubState();
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'ghost.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    const results = await executeMultiFilePlan(
      plan,
      pending,
      state,
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      8,
    );
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('ok');
    expect(state.logger?.warn).toHaveBeenCalledWith(expect.stringContaining('ghost.ts'));
  });

  it('pending tool_use whose path the plan omitted surfaces as a "planner omitted" error result', async () => {
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => result(pendingTu.id, 'ok'));
    const pending = [tu('a.ts'), tu('b.ts')];
    const plan: EditPlan = {
      edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }], // b.ts omitted
    };
    const results = await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      new AbortController().signal,
      8,
    );
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('ok');
    expect(results[1].is_error).toBe(true);
    expect(String(results[1].content)).toMatch(/planner omitted|not executed/i);
  });
});

describe('executeMultiFilePlan — error handling', () => {
  it('promotes a rejected executeOneToolUse into a synthetic error result (pool keeps draining)', async () => {
    vi.mocked(executeOneToolUse)
      .mockImplementationOnce(async (_ctx, pendingTu) => {
        if (pendingTu.input.path === 'bad.ts') throw new Error('disk full');
        return result(pendingTu.id, 'ok');
      })
      .mockImplementation(async (_ctx, pendingTu) => result(pendingTu.id, 'ok'));
    const pending = [tu('bad.ts'), tu('a.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'bad.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    const cb = stubCallbacks();
    const results = await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
      8,
    );
    expect(results[0].is_error).toBe(true);
    expect(String(results[0].content)).toContain('disk full');
    expect(results[1].content).toBe('ok');
    expect(cb.onToolResult).toHaveBeenCalledWith('write_file', expect.stringContaining('disk full'), true, 'tu-bad.ts');
  });
});

describe('executeMultiFilePlan — abort', () => {
  it('stops dispatching later layers when the signal aborts mid-run', async () => {
    const ctrl = new AbortController();
    let callCount = 0;
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => {
      callCount += 1;
      if (callCount === 1) ctrl.abort(); // abort during first layer
      return result(pendingTu.id, 'ok');
    });
    const pending = [tu('a.ts'), tu('b.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: ['a.ts'] }, // layer 2
      ],
    };
    const results = await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      stubCallbacks(),
      ctrl.signal,
      8,
    );
    // a.ts ran, b.ts did not (signal aborted before layer 2 starts)
    expect(results[0].content).toBe('ok');
    expect(results[1].is_error).toBe(true);
    expect(callCount).toBe(1);
  });
});

// `runWithCap` tests moved to `src/agent/parallelDispatch.test.ts` (v0.67
// chunk 2) — the primitive now lives in `src/agent/parallelDispatch.ts`
// and is shared between multi-file edit + facet dispatch + upcoming
// fork dispatch. The re-export from this module preserves the import
// path for any external consumers.

describe('executeMultiFilePlan — onEditPlanProgress events (v0.66 chunk 1, slim 4.4b)', () => {
  it('emits writing + done transitions for each successful edit', async () => {
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => result(pendingTu.id, 'ok'));
    const pending = [tu('a.ts'), tu('b.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    const cb = stubCallbacks();
    await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
      8,
    );
    const progressCalls = (cb.onEditPlanProgress as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { path: string; status: string },
    );
    // Each path fires 'writing' → 'done'.
    const aEvents = progressCalls.filter((p) => p.path === 'a.ts').map((p) => p.status);
    const bEvents = progressCalls.filter((p) => p.path === 'b.ts').map((p) => p.status);
    expect(aEvents).toEqual(['writing', 'done']);
    expect(bEvents).toEqual(['writing', 'done']);
  });

  it('emits failed with errorMessage on a rejected task', async () => {
    vi.mocked(executeOneToolUse).mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    const pending = [tu('a.ts')];
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    const cb = stubCallbacks();
    await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
      8,
    );
    const calls = (cb.onEditPlanProgress as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const failed = calls.find((c) => c.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed.errorMessage).toContain('disk full');
  });

  it('emits failed when executeOneToolUse returns is_error: true (without throwing)', async () => {
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => ({
      type: 'tool_result',
      tool_use_id: pendingTu.id,
      content: 'permission denied',
      is_error: true,
    }));
    const pending = [tu('a.ts')];
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    const cb = stubCallbacks();
    await executeMultiFilePlan(
      plan,
      pending,
      stubState(),
      {} as SideCarClient,
      {} as AgentOptions,
      cb,
      new AbortController().signal,
      8,
    );
    const statuses = (cb.onEditPlanProgress as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { status: string }).status,
    );
    expect(statuses).toContain('failed');
  });

  it('emits aborted for unclaimed edits when signal fires mid-walk', async () => {
    const ctrl = new AbortController();
    vi.mocked(executeOneToolUse).mockImplementation(async (_ctx, pendingTu) => {
      ctrl.abort(); // abort after first layer runs
      return result(pendingTu.id, 'ok');
    });
    const pending = [tu('a.ts'), tu('b.ts')];
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: ['a.ts'] }, // layer 2
      ],
    };
    const cb = stubCallbacks();
    await executeMultiFilePlan(plan, pending, stubState(), {} as SideCarClient, {} as AgentOptions, cb, ctrl.signal, 8);
    const bStatuses = (cb.onEditPlanProgress as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as { path: string; status: string })
      .filter((p) => p.path === 'b.ts')
      .map((p) => p.status);
    expect(bStatuses).toEqual(['aborted']);
  });
});
