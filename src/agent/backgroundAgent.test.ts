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
