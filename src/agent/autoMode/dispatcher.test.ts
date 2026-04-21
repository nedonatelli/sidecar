import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAutoMode, type AutoModeOptions, type AutoModeCallbacks } from './dispatcher.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../shadow/sandbox.js', () => ({
  runAgentLoopInSandbox: vi.fn().mockResolvedValue({ mode: 'direct', applied: true }),
}));

import * as fsMod from 'fs/promises';
import * as sandboxMod from '../shadow/sandbox.js';

const readFile = vi.mocked(fsMod.readFile);
const writeFile = vi.mocked(fsMod.writeFile);
const runAgentLoopInSandbox = vi.mocked(sandboxMod.runAgentLoopInSandbox);

function makeClient(): SideCarClient & { setTurnOverride: ReturnType<typeof vi.fn> } {
  return { setTurnOverride: vi.fn() } as unknown as SideCarClient & {
    setTurnOverride: ReturnType<typeof vi.fn>;
  };
}

function makeCallbacks(): AutoModeCallbacks {
  return {
    onTaskStart: vi.fn(),
    onTaskDone: vi.fn(),
    onTaskError: vi.fn(),
    onSessionEnd: vi.fn(),
  };
}

function makeAgentCallbacks(): AgentCallbacks {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

const BASE_OPTS: AutoModeOptions = {
  backlogPath: '/workspace/.sidecar/backlog.md',
  maxTasksPerSession: 10,
  maxRuntimeMs: 60_000,
  haltOnFailure: false,
  interTaskCooldownMs: 0,
};

const BACKLOG_ONE = '- [ ] Write unit tests\n';
const BACKLOG_TWO = '- [ ] Write unit tests\n- [ ] Fix lint errors\n';
const BACKLOG_DONE = '- [x] Already done\n';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runAutoMode — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: file reads return a one-item backlog, then the updated (done) version
    readFile
      .mockResolvedValueOnce(BACKLOG_ONE as never) // first read for item
      .mockResolvedValueOnce(BACKLOG_ONE as never); // re-read before markItemDone
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs one task, marks it done, and reports completed', async () => {
    // After marking done the second read in the loop returns empty backlog
    readFile
      .mockReset()
      .mockResolvedValueOnce(BACKLOG_ONE as never) // initial read
      .mockResolvedValueOnce(BACKLOG_ONE as never) // re-read for markItemDone
      .mockResolvedValueOnce('- [x] Write unit tests\n' as never); // third read → all done

    const cbs = makeCallbacks();
    const result = await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), cbs);

    expect(runAgentLoopInSandbox).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledOnce();
    expect(cbs.onTaskStart).toHaveBeenCalledOnce();
    expect(cbs.onTaskDone).toHaveBeenCalledOnce();
    expect(result.tasksSucceeded).toBe(1);
    expect(result.stoppedReason).toBe('completed');
  });

  it('fires onSessionEnd with the final result', async () => {
    readFile
      .mockReset()
      .mockResolvedValueOnce(BACKLOG_ONE as never)
      .mockResolvedValueOnce(BACKLOG_ONE as never)
      .mockResolvedValueOnce(BACKLOG_DONE as never);

    const cbs = makeCallbacks();
    await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), cbs);
    expect(cbs.onSessionEnd).toHaveBeenCalledOnce();
    const [result] = vi.mocked(cbs.onSessionEnd).mock.calls[0];
    expect(result.stoppedReason).toBe('completed');
  });
});

describe('runAutoMode — empty / all-done backlog', () => {
  it('stops immediately with completed when backlog file is missing', async () => {
    readFile.mockReset().mockRejectedValueOnce(new Error('ENOENT') as never);

    const cbs = makeCallbacks();
    const result = await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), cbs);

    expect(runAgentLoopInSandbox).not.toHaveBeenCalled();
    expect(result.stoppedReason).toBe('completed');
    expect(result.tasksAttempted).toBe(0);
  });

  it('stops immediately when all items are already done', async () => {
    readFile.mockReset().mockResolvedValue(BACKLOG_DONE as never);

    const cbs = makeCallbacks();
    const result = await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), cbs);

    expect(runAgentLoopInSandbox).not.toHaveBeenCalled();
    expect(result.stoppedReason).toBe('completed');
  });
});

describe('runAutoMode — task cap', () => {
  it('stops after maxTasksPerSession tasks', async () => {
    // Always return a two-item pending backlog so the loop would run forever
    readFile.mockReset().mockResolvedValue(BACKLOG_TWO as never);

    const cbs = makeCallbacks();
    const opts: AutoModeOptions = { ...BASE_OPTS, maxTasksPerSession: 1 };
    const result = await runAutoMode(makeClient(), opts, makeAgentCallbacks(), cbs);

    expect(runAgentLoopInSandbox).toHaveBeenCalledOnce();
    expect(result.stoppedReason).toBe('task-cap');
  });
});

describe('runAutoMode — cancellation', () => {
  it('stops immediately when signal is already aborted', async () => {
    readFile.mockReset().mockResolvedValue(BACKLOG_ONE as never);

    const controller = new AbortController();
    controller.abort();

    const cbs = makeCallbacks();
    const result = await runAutoMode(
      makeClient(),
      { ...BASE_OPTS, abortSignal: controller.signal },
      makeAgentCallbacks(),
      cbs,
    );

    expect(runAgentLoopInSandbox).not.toHaveBeenCalled();
    expect(result.stoppedReason).toBe('cancelled');
  });
});

describe('runAutoMode — error handling', () => {
  it('calls onTaskError and continues when haltOnFailure is false', async () => {
    // Iteration 1: read backlog, task fails; iteration 2: re-read, same task, succeeds.
    // maxTasksPerSession:2 stops the loop after the retry so we don't bleed into a third run.
    readFile
      .mockReset()
      .mockResolvedValueOnce(BACKLOG_TWO as never) // iteration 1: pick item
      .mockResolvedValueOnce(BACKLOG_TWO as never) // iteration 2: pick item (retry)
      .mockResolvedValueOnce(BACKLOG_TWO as never); // iteration 2: re-read for markItemDone

    runAgentLoopInSandbox
      .mockReset()
      .mockRejectedValueOnce(new Error('Agent failed') as never)
      .mockResolvedValueOnce({ mode: 'direct', applied: true } as never);

    const cbs = makeCallbacks();
    const result = await runAutoMode(
      makeClient(),
      { ...BASE_OPTS, haltOnFailure: false, maxTasksPerSession: 2 },
      makeAgentCallbacks(),
      cbs,
    );

    expect(cbs.onTaskError).toHaveBeenCalledOnce();
    expect(result.tasksFailed).toBe(1);
    expect(result.tasksSucceeded).toBe(1);
  });

  it('halts after first failure when haltOnFailure is true', async () => {
    readFile.mockReset().mockResolvedValue(BACKLOG_TWO as never);

    runAgentLoopInSandbox.mockReset().mockRejectedValue(new Error('boom') as never);

    const cbs = makeCallbacks();
    const result = await runAutoMode(makeClient(), { ...BASE_OPTS, haltOnFailure: true }, makeAgentCallbacks(), cbs);

    expect(runAgentLoopInSandbox).toHaveBeenCalledOnce();
    expect(result.stoppedReason).toBe('halted-on-failure');
    expect(result.tasksFailed).toBe(1);
    expect(result.tasksSucceeded).toBe(0);
  });
});

describe('runAutoMode — per-item sentinels', () => {
  it('calls setTurnOverride with model before task and restores null after', async () => {
    const backlogWithModel = '- [ ] Refactor auth @model:claude-opus-4-7\n';
    readFile
      .mockReset()
      .mockResolvedValueOnce(backlogWithModel as never) // pick item
      .mockResolvedValueOnce(backlogWithModel as never) // re-read for markItemDone
      .mockResolvedValueOnce('- [x] Refactor auth @model:claude-opus-4-7\n' as never); // all done

    const client = makeClient();
    await runAutoMode(client, BASE_OPTS, makeAgentCallbacks(), makeCallbacks());

    expect(client.setTurnOverride).toHaveBeenCalledWith('claude-opus-4-7');
    expect(client.setTurnOverride).toHaveBeenLastCalledWith(null);
  });

  it('passes forceShadow:true when @shadowMode:always', async () => {
    const backlog = '- [ ] Task @shadowMode:always\n';
    readFile
      .mockReset()
      .mockResolvedValueOnce(backlog as never)
      .mockResolvedValueOnce(backlog as never)
      .mockResolvedValueOnce('- [x] Task @shadowMode:always\n' as never);
    runAgentLoopInSandbox.mockReset().mockResolvedValue({ mode: 'direct', applied: true } as never);

    await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), makeCallbacks());

    expect(runAgentLoopInSandbox).toHaveBeenCalledOnce();
    const [, , , , , sandboxOpts] = vi.mocked(runAgentLoopInSandbox).mock.calls[0];
    expect(sandboxOpts).toMatchObject({ forceShadow: true, suppressShadow: false });
  });

  it('passes suppressShadow:true when @shadowMode:off', async () => {
    const backlog = '- [ ] Task @shadowMode:off\n';
    readFile
      .mockReset()
      .mockResolvedValueOnce(backlog as never)
      .mockResolvedValueOnce(backlog as never)
      .mockResolvedValueOnce('- [x] Task @shadowMode:off\n' as never);
    runAgentLoopInSandbox.mockReset().mockResolvedValue({ mode: 'direct', applied: true } as never);

    await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), makeCallbacks());

    const [, , , , , sandboxOpts] = vi.mocked(runAgentLoopInSandbox).mock.calls[0];
    expect(sandboxOpts).toMatchObject({ forceShadow: false, suppressShadow: true });
  });

  it('strips sentinels from the task prompt', async () => {
    const backlog = '- [ ] Write tests @model:qwen3:14b\n';
    readFile
      .mockReset()
      .mockResolvedValueOnce(backlog as never)
      .mockResolvedValueOnce(backlog as never)
      .mockResolvedValueOnce('- [x] Write tests @model:qwen3:14b\n' as never);

    await runAutoMode(makeClient(), BASE_OPTS, makeAgentCallbacks(), makeCallbacks());

    const [, messages] = vi.mocked(runAgentLoopInSandbox).mock.calls[0];
    expect(messages[0].content).toContain('Write tests');
    expect(messages[0].content).not.toContain('@model:');
  });
});
