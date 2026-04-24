import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for dispatchToolUses.ts (v0.65 chunk 4.3b).
//
// Orchestration decisions covered:
//   - Mixed tool_use (any non-write) → skip planner, delegate to
//     executeToolUses regardless of count.
//   - Non-write-only batch < threshold → executeToolUses.
//   - Pure-write batch ≥ threshold → requestEditPlan runs; on plan,
//     executeMultiFilePlan runs; on plan=null, fall back to
//     executeToolUses.
//   - Plan surfaces via onEditPlan callback.
//   - latestUserPromptText scans both string and content-block
//     content for @no-plan sentinel suppression.
// ---------------------------------------------------------------------------

vi.mock('../editPlanner.js', () => ({
  shouldRunPlannerPass: vi.fn(),
  requestEditPlan: vi.fn(),
  NO_PLAN_SENTINEL: '@no-plan',
}));
vi.mock('./multiFileEdit.js', () => ({
  executeMultiFilePlan: vi.fn(),
}));
vi.mock('./executeToolUses.js', () => ({
  executeToolUses: vi.fn(),
}));

import { dispatchPendingToolUses } from './dispatchToolUses.js';
import { shouldRunPlannerPass, requestEditPlan } from '../editPlanner.js';
import { executeMultiFilePlan } from './multiFileEdit.js';
import { executeToolUses } from './executeToolUses.js';
import type { LoopState } from './state.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { EditPlan } from '../editPlan.js';
import type { SideCarConfig } from '../../config/settings.js';

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    runId: 'test-task',
    config: {} as import('../../config/settings.js').SideCarConfig,
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: { info: vi.fn(), warn: vi.fn() } as unknown as LoopState['logger'],
    changelog: undefined,
    mcpManager: undefined,
    messages: [{ role: 'user', content: 'refactor auth' }],
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
  const cb = {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    onEditPlan: vi.fn(),
  };
  return cb as typeof cb & AgentCallbacks;
}

function config(overrides: Partial<SideCarConfig> = {}): SideCarConfig {
  return {
    multiFileEditsEnabled: true,
    multiFileEditsPlanningPass: true,
    multiFileEditsMinFilesForPlan: 3,
    multiFileEditsMaxParallel: 8,
    multiFileEditsPlannerModel: '',
    multiFileEditsReviewGranularity: 'per-file',
    ...overrides,
  } as unknown as SideCarConfig;
}

function tu(name: string, path = 'a.ts', id?: string): ToolUseContentBlock {
  return { type: 'tool_use', id: id ?? `tu-${name}-${path}`, name, input: { path } };
}

const signal = new AbortController().signal;
const client = {} as SideCarClient;
const options = {} as AgentOptions;

beforeEach(() => {
  vi.mocked(shouldRunPlannerPass).mockReset();
  vi.mocked(requestEditPlan).mockReset();
  vi.mocked(executeMultiFilePlan).mockReset();
  vi.mocked(executeToolUses).mockReset().mockResolvedValue([]);
});

describe('dispatchPendingToolUses — mixed tool_use', () => {
  it('skips planner and delegates to executeToolUses when batch has any non-write', async () => {
    const pending = [
      tu('write_file', 'a.ts'),
      tu('write_file', 'b.ts'),
      tu('read_file', 'c.ts'),
      tu('write_file', 'd.ts'),
    ];
    await dispatchPendingToolUses(stubState(), pending, client, options, stubCallbacks(), signal, config());
    expect(shouldRunPlannerPass).not.toHaveBeenCalled();
    expect(requestEditPlan).not.toHaveBeenCalled();
    expect(executeToolUses).toHaveBeenCalledOnce();
  });

  it('skips planner when batch is pure-non-write tools', async () => {
    const pending = [tu('read_file', 'a.ts'), tu('grep', 'b.ts')];
    await dispatchPendingToolUses(stubState(), pending, client, options, stubCallbacks(), signal, config());
    expect(shouldRunPlannerPass).not.toHaveBeenCalled();
    expect(executeToolUses).toHaveBeenCalledOnce();
  });
});

describe('dispatchPendingToolUses — gate decisions', () => {
  it('pure-writes but gate returns false → executeToolUses', async () => {
    vi.mocked(shouldRunPlannerPass).mockReturnValue(false);
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts')];
    await dispatchPendingToolUses(stubState(), pending, client, options, stubCallbacks(), signal, config());
    expect(shouldRunPlannerPass).toHaveBeenCalledOnce();
    expect(requestEditPlan).not.toHaveBeenCalled();
    expect(executeToolUses).toHaveBeenCalledOnce();
  });

  it('pure-writes + gate true → requestEditPlan + executeMultiFilePlan', async () => {
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan, rawText: 'raw', retried: false });
    vi.mocked(executeMultiFilePlan).mockResolvedValue([]);
    const cb = stubCallbacks();
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(stubState(), pending, client, options, cb, signal, config());
    expect(requestEditPlan).toHaveBeenCalledOnce();
    expect(executeMultiFilePlan).toHaveBeenCalledOnce();
    expect(executeToolUses).not.toHaveBeenCalled();
    expect(cb.onEditPlan).toHaveBeenCalledWith(plan);
  });

  it('seeds onEditPlanProgress with status=pending for every plan path before execution (v0.66 chunk 1)', async () => {
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: '', dependsOn: [] },
        { path: 'c.ts', op: 'edit', rationale: '', dependsOn: [] },
      ],
    };
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan, rawText: 'raw', retried: false });
    vi.mocked(executeMultiFilePlan).mockResolvedValue([]);
    const onEditPlanProgress = vi.fn();
    const cb = { ...stubCallbacks(), onEditPlanProgress } as ReturnType<typeof stubCallbacks>;
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(stubState(), pending, client, options, cb, signal, config());
    const pendingEvents = onEditPlanProgress.mock.calls
      .map((c) => c[0] as { path: string; status: string })
      .filter((e) => e.status === 'pending');
    expect(pendingEvents.map((e) => e.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('falls back to executeToolUses when planner returns plan=null', async () => {
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan: null, rawText: 'raw', retried: true });
    const cb = stubCallbacks();
    const state = stubState();
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, cb, signal, config());
    expect(executeMultiFilePlan).not.toHaveBeenCalled();
    expect(executeToolUses).toHaveBeenCalledOnce();
    expect(cb.onEditPlan).not.toHaveBeenCalled();
    expect(state.logger?.warn).toHaveBeenCalledWith(expect.stringContaining('no valid plan'));
  });
});

describe('dispatchPendingToolUses — user prompt sentinel scan', () => {
  it('passes the latest user string-content to shouldRunPlannerPass', async () => {
    vi.mocked(shouldRunPlannerPass).mockReturnValue(false);
    const state = stubState({
      messages: [
        { role: 'user', content: 'initial task' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '@no-plan just do it' },
      ],
    });
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, stubCallbacks(), signal, config());
    const call = vi.mocked(shouldRunPlannerPass).mock.calls[0];
    expect(call[1].userPromptText).toBe('@no-plan just do it');
  });

  it('walks content-block arrays to find the first text block on the latest user message', async () => {
    vi.mocked(shouldRunPlannerPass).mockReturnValue(false);
    const state = stubState({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '…' } },
            { type: 'text', text: 'please refactor @no-plan' },
          ] as never,
        },
      ],
    });
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, stubCallbacks(), signal, config());
    expect(vi.mocked(shouldRunPlannerPass).mock.calls[0][1].userPromptText).toContain('@no-plan');
  });

  it('empty when there is no user message (treats as "sentinel not present")', async () => {
    vi.mocked(shouldRunPlannerPass).mockReturnValue(false);
    const state = stubState({ messages: [{ role: 'assistant', content: 'hi' }] });
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, stubCallbacks(), signal, config());
    expect(vi.mocked(shouldRunPlannerPass).mock.calls[0][1].userPromptText).toBe('');
  });
});

describe('dispatchPendingToolUses — currentEditPlan lifecycle (v0.65 chunk 4.5a)', () => {
  it('sets state.currentEditPlan before executeMultiFilePlan runs, keeps it set after dispatch returns', async () => {
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan, rawText: '', retried: false });
    let observedPlan: EditPlan | null = null;
    vi.mocked(executeMultiFilePlan).mockImplementation(async (_p, _pu, state) => {
      observedPlan = state.currentEditPlan;
      return [];
    });
    const state = stubState();
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, stubCallbacks(), signal, config());
    expect(observedPlan).toBe(plan);
    // Still set after dispatch returns so post-turn hooks can observe it.
    expect(state.currentEditPlan).toBe(plan);
  });

  it('clears currentEditPlan at the top of the NEXT dispatch call (ages it out)', async () => {
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    vi.mocked(shouldRunPlannerPass).mockReturnValueOnce(true).mockReturnValueOnce(false);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan, rawText: '', retried: false });
    vi.mocked(executeMultiFilePlan).mockResolvedValue([]);
    const state = stubState();
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, stubCallbacks(), signal, config());
    expect(state.currentEditPlan).toBe(plan);

    // Second call — even for a non-planned batch — must clear the stale plan.
    await dispatchPendingToolUses(state, [tu('read_file', 'x.ts')], client, options, stubCallbacks(), signal, config());
    expect(state.currentEditPlan).toBeNull();
  });

  it('leaves currentEditPlan null when the planner falls back to executeToolUses', async () => {
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan: null, rawText: '', retried: true });
    const state = stubState();
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(state, pending, client, options, stubCallbacks(), signal, config());
    expect(state.currentEditPlan).toBeNull();
  });
});

describe('dispatchPendingToolUses — config threading', () => {
  it('passes plannerModel config into requestEditPlan (empty string → undefined)', async () => {
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan, rawText: '', retried: false });
    vi.mocked(executeMultiFilePlan).mockResolvedValue([]);
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(
      stubState(),
      pending,
      client,
      options,
      stubCallbacks(),
      signal,
      config({ multiFileEditsPlannerModel: 'haiku-model' }),
    );
    expect(vi.mocked(requestEditPlan).mock.calls[0][3]?.plannerModel).toBe('haiku-model');
  });

  it('passes maxParallel into executeMultiFilePlan', async () => {
    const plan: EditPlan = { edits: [{ path: 'a.ts', op: 'edit', rationale: '', dependsOn: [] }] };
    vi.mocked(shouldRunPlannerPass).mockReturnValue(true);
    vi.mocked(requestEditPlan).mockResolvedValue({ plan, rawText: '', retried: false });
    vi.mocked(executeMultiFilePlan).mockResolvedValue([]);
    const pending = [tu('write_file', 'a.ts'), tu('write_file', 'b.ts'), tu('write_file', 'c.ts')];
    await dispatchPendingToolUses(
      stubState(),
      pending,
      client,
      options,
      stubCallbacks(),
      signal,
      config({ multiFileEditsMaxParallel: 16 }),
    );
    expect(vi.mocked(executeMultiFilePlan).mock.calls[0][7]).toBe(16);
  });
});
