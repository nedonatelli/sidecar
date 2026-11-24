import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgentLoop } from './loop.js';
import { getConfig } from '../config/settings.js';
import type { StreamEvent } from '../ollama/types.js';
import type { SideCarClient } from '../ollama/client.js';
import type { AgentCallbacks } from './loop.js';

const { cleanup } = vi.hoisted(() => ({ cleanup: vi.fn(async () => {}) }));

vi.mock('./loop/scratchCleanup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./loop/scratchCleanup.js')>()),
  cleanupScratchAtTermination: cleanup,
}));

vi.mock('./tools.js', () => ({
  getToolDefinitions: () => [],
  getToolDefinitionsForTier: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

// #511: scratch cleanup is skipped on an abort, so a user's Stop leaves their
// files alone. The SWE harness's per-task timer aborts the same way, and a
// timed-out run's diff shipped every reproduction script it wrote (gemma4:31b,
// sympy-13146: six debug_*.py files in one patch). scratchCleanupOnAbort runs
// it anyway, on both ways an abort ends the loop.

const callbacks = (): AgentCallbacks => ({
  onText: () => {},
  onToolCall: () => {},
  onToolResult: () => {},
  onDone: () => {},
});

function client(streamChat: () => AsyncGenerator<StreamEvent>): SideCarClient {
  return {
    streamChat,
    getSystemPrompt: () => '',
    getRouter: () => null,
    getModel: () => 'mock-model',
  } as unknown as SideCarClient;
}

/** A model request the timer cuts off: it hangs, and the signal fires while it waits. */
const abortedMidRequest = (ac: AbortController) =>
  client(async function* () {
    ac.abort();
    await new Promise<never>(() => {});
  });

const run = (c: SideCarClient, signal: AbortSignal, scratchCleanupOnAbort?: boolean) =>
  runAgentLoop(c, [{ role: 'user', content: 'fix the bug' }], callbacks(), signal, {
    approvalMode: 'autonomous',
    maxIterations: 5,
    config: { ...getConfig(), completionGateEnabled: false, adaptiveScaffoldingEnabled: false },
    ...(scratchCleanupOnAbort !== undefined ? { scratchCleanupOnAbort } : {}),
  });

beforeEach(() => cleanup.mockClear());

describe('scratch cleanup on an aborted run (#511)', () => {
  it('is skipped when a request is aborted and the option is off (a user Stop)', async () => {
    const ac = new AbortController();
    await run(abortedMidRequest(ac), ac.signal).catch(() => {});
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('runs once when a request is aborted and the option is on (a harness timer)', async () => {
    const ac = new AbortController();
    await run(abortedMidRequest(ac), ac.signal, true).catch(() => {});
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs once when the signal is already aborted between turns', async () => {
    const ac = new AbortController();
    ac.abort();
    const never = client(async function* () {
      yield { type: 'stop', stopReason: 'end_turn' } as StreamEvent;
    });
    await run(never, ac.signal, true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    cleanup.mockClear();
    await run(never, ac.signal);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('runs on a natural finish either way', async () => {
    const done = client(async function* () {
      yield { type: 'text', text: 'Done.' } as StreamEvent;
      yield { type: 'stop', stopReason: 'end_turn' } as StreamEvent;
    });
    await run(done, new AbortController().signal);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
