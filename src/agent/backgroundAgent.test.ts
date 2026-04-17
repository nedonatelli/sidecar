import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BackgroundAgentCallbacks } from './backgroundAgent.js';

// Integration test for the per-run ToolRuntime wiring: the manager must
// construct a fresh ToolRuntime for every `executeRun`, hand it to
// runAgentLoop via options.toolRuntime, and call its `dispose()` on
// finally — both the success path and the failure path. Parallel
// background agents that both `cd` or `export` would trample each
// other without this isolation.

const { runAgentLoopMock, ToolRuntimeMock, toolRuntimeInstances } = vi.hoisted(() => {
  const instances: Array<{ id: number; dispose: ReturnType<typeof vi.fn> }> = [];
  let counter = 0;
  class ToolRuntimeStub {
    readonly id: number;
    dispose: ReturnType<typeof vi.fn>;
    getShellSession = vi.fn();
    symbolGraph = null;
    constructor() {
      counter += 1;
      this.id = counter;
      this.dispose = vi.fn();
      instances.push(this);
    }
  }
  return {
    runAgentLoopMock: vi.fn(),
    ToolRuntimeMock: ToolRuntimeStub,
    toolRuntimeInstances: instances,
  };
});

vi.mock('vscode', () => ({
  Disposable: class {},
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock' } }],
  },
}));

vi.mock('../ollama/client.js', () => ({
  SideCarClient: class {
    updateSystemPrompt = vi.fn();
  },
}));

vi.mock('../config/settings.js', () => ({
  getConfig: () => ({
    model: 'test-model',
    baseUrl: 'http://localhost:11434',
    apiKey: 'test',
    bgMaxConcurrent: 3,
  }),
}));

vi.mock('./loop.js', () => ({
  runAgentLoop: runAgentLoopMock,
}));

vi.mock('./tools/runtime.js', () => ({
  ToolRuntime: ToolRuntimeMock,
}));

import { BackgroundAgentManager } from './backgroundAgent.js';

function makeCallbacks(): BackgroundAgentCallbacks {
  return {
    onStatusChange: vi.fn(),
    onOutput: vi.fn(),
    onComplete: vi.fn(),
  };
}

async function flush(): Promise<void> {
  // Let the queued microtasks in executeRun resolve (runAgentLoop is
  // awaited, then the status/complete callbacks fire, then finally
  // disposes the runtime).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('BackgroundAgentManager ToolRuntime wiring', () => {
  beforeEach(() => {
    runAgentLoopMock.mockReset();
    toolRuntimeInstances.length = 0;
  });

  it('constructs a fresh ToolRuntime per run and passes it via AgentOptions', async () => {
    runAgentLoopMock.mockResolvedValue(undefined);
    const mgr = new BackgroundAgentManager(makeCallbacks());
    mgr.start('find TODOs');
    await flush();

    expect(toolRuntimeInstances).toHaveLength(1);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    const options = runAgentLoopMock.mock.calls[0][4];
    expect(options.toolRuntime).toBe(toolRuntimeInstances[0]);
    expect(options.approvalMode).toBe('autonomous');
  });

  it('disposes the ToolRuntime on the success path', async () => {
    runAgentLoopMock.mockResolvedValue(undefined);
    const mgr = new BackgroundAgentManager(makeCallbacks());
    mgr.start('task A');
    await flush();

    expect(toolRuntimeInstances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the ToolRuntime on the failure path', async () => {
    runAgentLoopMock.mockRejectedValue(new Error('boom'));
    const mgr = new BackgroundAgentManager(makeCallbacks());
    mgr.start('task that fails');
    await flush();

    expect(toolRuntimeInstances[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('parallel runs each get a distinct ToolRuntime', async () => {
    // Don't resolve runAgentLoop immediately so two runs can be
    // in-flight at once. Using a manual deferred lets us assert
    // instance count before either finishes.
    let resolveA!: () => void;
    let resolveB!: () => void;
    runAgentLoopMock
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveA = r)))
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveB = r)));

    const mgr = new BackgroundAgentManager(makeCallbacks());
    mgr.start('task A');
    mgr.start('task B');
    await flush();

    expect(toolRuntimeInstances).toHaveLength(2);
    expect(toolRuntimeInstances[0]).not.toBe(toolRuntimeInstances[1]);
    // Neither disposed yet — both runs still in flight.
    expect(toolRuntimeInstances[0].dispose).not.toHaveBeenCalled();
    expect(toolRuntimeInstances[1].dispose).not.toHaveBeenCalled();

    resolveA();
    resolveB();
    await flush();

    expect(toolRuntimeInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(toolRuntimeInstances[1].dispose).toHaveBeenCalledTimes(1);
  });
});

// v0.62.3 — slot-limit + queue-drain coverage. The manager's
// drainQueue() respects getConfig().bgMaxConcurrent (mocked to 3
// above) but the previous test set didn't actually assert that
// guard. These tests exercise the 4th-run-gets-queued path and
// the slot-frees-drains-queue path.
describe('BackgroundAgentManager slot limit + queue drain', () => {
  beforeEach(() => {
    runAgentLoopMock.mockReset();
    toolRuntimeInstances.length = 0;
  });

  it('runs up to bgMaxConcurrent in parallel; the 4th stays queued', async () => {
    const deferreds: Array<() => void> = [];
    runAgentLoopMock.mockImplementation(() => new Promise<void>((r) => deferreds.push(r)));

    const mgr = new BackgroundAgentManager(makeCallbacks());
    const id1 = mgr.start('A');
    const id2 = mgr.start('B');
    const id3 = mgr.start('C');
    const id4 = mgr.start('D');
    await flush();

    // Exactly 3 runs should have entered executeRun (→ constructed
    // a ToolRuntime). The 4th must stay queued — if the guard fails,
    // we'd see 4 instances here.
    expect(toolRuntimeInstances).toHaveLength(3);
    expect(runAgentLoopMock).toHaveBeenCalledTimes(3);

    const runs = mgr.list();
    expect(runs.find((r) => r.id === id1)?.status).toBe('running');
    expect(runs.find((r) => r.id === id2)?.status).toBe('running');
    expect(runs.find((r) => r.id === id3)?.status).toBe('running');
    expect(runs.find((r) => r.id === id4)?.status).toBe('queued');

    // Cleanup: let everything finish so the test doesn't leak
    // pending promises.
    deferreds.forEach((r) => r());
    await flush();
    await flush();
  });

  it('drains the queue when a running slot frees', async () => {
    const deferreds: Array<() => void> = [];
    runAgentLoopMock.mockImplementation(() => new Promise<void>((r) => deferreds.push(r)));

    const mgr = new BackgroundAgentManager(makeCallbacks());
    mgr.start('A');
    mgr.start('B');
    mgr.start('C');
    const id4 = mgr.start('D');
    await flush();

    expect(mgr.get(id4)?.status).toBe('queued');

    // Finish run A — a slot should open, D should transition to running.
    deferreds[0]();
    await flush();
    await flush();

    expect(toolRuntimeInstances).toHaveLength(4);
    expect(mgr.get(id4)?.status).toBe('running');

    // Let the remaining runs finish cleanly.
    deferreds.slice(1).forEach((r) => r());
    await flush();
    await flush();
  });

  it('stopping a queued run frees its slot and does NOT consume one that would have gone to the next queued run', async () => {
    const deferreds: Array<() => void> = [];
    runAgentLoopMock.mockImplementation(() => new Promise<void>((r) => deferreds.push(r)));

    const mgr = new BackgroundAgentManager(makeCallbacks());
    mgr.start('A');
    mgr.start('B');
    mgr.start('C');
    const idQueued1 = mgr.start('D');
    const idQueued2 = mgr.start('E');
    await flush();

    // 3 runners, 2 queued.
    expect(toolRuntimeInstances).toHaveLength(3);
    expect(mgr.get(idQueued1)?.status).toBe('queued');
    expect(mgr.get(idQueued2)?.status).toBe('queued');

    // Cancel D (queued) — should NOT cause any drain because no
    // slot freed; E should still stay queued.
    mgr.stop(idQueued1);
    await flush();

    expect(mgr.get(idQueued1)?.status).toBe('cancelled');
    expect(mgr.get(idQueued2)?.status).toBe('queued');
    // No new ToolRuntime constructed for D (it never ran).
    expect(toolRuntimeInstances).toHaveLength(3);

    deferreds.forEach((r) => r());
    await flush();
    await flush();
  });

  it('stopping a running run frees the slot; the next queued run drains into it', async () => {
    const deferreds: Array<() => void> = [];
    runAgentLoopMock.mockImplementation(() => new Promise<void>((r) => deferreds.push(r)));

    const mgr = new BackgroundAgentManager(makeCallbacks());
    const idA = mgr.start('A');
    mgr.start('B');
    mgr.start('C');
    const idQueued = mgr.start('D');
    await flush();

    expect(mgr.get(idQueued)?.status).toBe('queued');

    // Abort A while it's running. The abort triggers cancelled state
    // + drainQueue — D should pick up the freed slot.
    mgr.stop(idA);
    await flush();
    await flush();

    expect(mgr.get(idA)?.status).toBe('cancelled');
    expect(mgr.get(idQueued)?.status).toBe('running');
    expect(toolRuntimeInstances).toHaveLength(4);

    // Drain remaining so the test exits cleanly. (Note: A's deferred
    // never resolves because we aborted it; executeRun's catch handles
    // that via the cancelled-status early return.)
    deferreds[0](); // A — still resolves, but status stays cancelled
    deferreds[1](); // B
    deferreds[2](); // C
    deferreds[3](); // D
    await flush();
    await flush();
  });

  it('status transitions: queued → running → completed', async () => {
    let resolveA!: () => void;
    runAgentLoopMock.mockImplementation(() => new Promise<void>((r) => (resolveA = r)));

    const callbacks = makeCallbacks();
    const statusSeen: Array<{ id: string; status: string }> = [];
    callbacks.onStatusChange = vi.fn((info) => {
      statusSeen.push({ id: info.id, status: info.status });
    });
    callbacks.onComplete = vi.fn((info) => {
      statusSeen.push({ id: info.id, status: info.status });
    });

    const mgr = new BackgroundAgentManager(callbacks);
    const id = mgr.start('lone task');
    await flush();

    // Pre-resolve we should have seen queued + running.
    const preTransitions = statusSeen.filter((s) => s.id === id).map((s) => s.status);
    expect(preTransitions).toEqual(['queued', 'running']);

    resolveA();
    await flush();
    await flush();

    const transitions = statusSeen.filter((s) => s.id === id).map((s) => s.status);
    expect(transitions).toEqual(['queued', 'running', 'completed']);
  });
});
