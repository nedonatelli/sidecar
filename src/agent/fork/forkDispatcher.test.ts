import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for forkDispatcher.ts (v0.67 chunk 3).
//
// Covers the headless dispatch primitive — no UI, no webview, just
// the parallel shadow-sandbox spawn + result collection contract.
// Real agent loops are mocked at the sandbox boundary so tests stay
// deterministic and fast.
// ---------------------------------------------------------------------------

const { runAgentLoopInSandboxMock } = vi.hoisted(() => ({
  runAgentLoopInSandboxMock: vi.fn(),
}));

vi.mock('../shadow/sandbox.js', () => ({
  runAgentLoopInSandbox: runAgentLoopInSandboxMock,
}));

import { dispatchForks, type ForkDispatchOptions } from './forkDispatcher.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';
import type { SandboxResult } from '../shadow/sandbox.js';

function makeClient(): SideCarClient {
  return {} as unknown as SideCarClient;
}

function makeCallbacks(): AgentCallbacks & {
  texts: string[];
  toolCalls: string[];
  toolResults: string[];
} {
  const texts: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  return {
    texts,
    toolCalls,
    toolResults,
    onText: (t: string) => texts.push(t),
    onToolCall: (name: string) => toolCalls.push(name),
    onToolResult: (name: string) => toolResults.push(name),
    onDone: vi.fn(),
  };
}

function shadowResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    mode: 'shadow',
    applied: false,
    reason: 'deferred',
    pendingDiff: 'diff --git a/x b/x\n+changed\n',
    shadowId: 's-1',
    ...overrides,
  };
}

function baseOptions(overrides: Partial<ForkDispatchOptions> = {}): ForkDispatchOptions {
  return {
    task: 'refactor the auth middleware',
    numForks: 3,
    maxConcurrent: 3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(() => {
  runAgentLoopInSandboxMock.mockReset();
});

// ---------------------------------------------------------------------------
// Basic dispatch
// ---------------------------------------------------------------------------

describe('dispatchForks — happy path', () => {
  it('spawns N shadow runs in parallel and returns one ForkResult per fork in input order', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());

    const batch = await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 3 }));

    expect(runAgentLoopInSandboxMock).toHaveBeenCalledTimes(3);
    expect(batch.results).toHaveLength(3);
    expect(batch.results.map((r) => r.forkId)).toEqual(['fork-0', 'fork-1', 'fork-2']);
    expect(batch.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(batch.results.every((r) => r.success)).toBe(true);
  });

  it('forces shadow + defer on every fork run', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());

    await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 2 }));

    for (const call of runAgentLoopInSandboxMock.mock.calls) {
      const sandboxOpts = call[5];
      expect(sandboxOpts).toEqual({ forceShadow: true, deferPrompt: true });
    }
  });

  it('passes approvalMode: autonomous to every fork', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());

    await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 2 }));

    for (const call of runAgentLoopInSandboxMock.mock.calls) {
      const agentOpts = call[4];
      expect(agentOpts.approvalMode).toBe('autonomous');
    }
  });

  it('captures the sandbox pendingDiff into each ForkResult', async () => {
    runAgentLoopInSandboxMock.mockImplementation(async () =>
      shadowResult({ pendingDiff: 'diff --git a/foo b/foo\n+uniq\n' }),
    );

    const batch = await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 2 }));

    for (const r of batch.results) {
      expect(r.sandbox.pendingDiff).toContain('+uniq');
    }
  });

  it('reports elapsedMs as wall-clock from dispatch to completion', async () => {
    runAgentLoopInSandboxMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return shadowResult();
    });

    const batch = await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 2 }));
    expect(batch.elapsedMs).toBeGreaterThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap
// ---------------------------------------------------------------------------

describe('dispatchForks — concurrency cap', () => {
  it('caps in-flight forks at options.maxConcurrent', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    runAgentLoopInSandboxMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return shadowResult();
    });

    await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 6, maxConcurrent: 2 }));
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('clamps maxConcurrent > numForks to numForks (no idle workers)', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());

    const batch = await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 2, maxConcurrent: 100 }));
    expect(batch.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('dispatchForks — failure isolation', () => {
  it('captures a single-fork failure as success: false without aborting the batch', async () => {
    runAgentLoopInSandboxMock
      .mockResolvedValueOnce(shadowResult()) // fork-0 ok
      .mockRejectedValueOnce(new Error('boom')) // fork-1 fails
      .mockResolvedValueOnce(shadowResult()); // fork-2 ok

    const batch = await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 3 }));

    expect(batch.results[0].success).toBe(true);
    expect(batch.results[1].success).toBe(false);
    expect(batch.results[1].errorMessage).toBe('boom');
    expect(batch.results[1].sandbox.mode).toBe('direct'); // synthesized no-shadow result
    expect(batch.results[2].success).toBe(true);
  });

  it('surfaces an abort-before-start as errorMessage === "aborted-before-start"', async () => {
    const ac = new AbortController();
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, _cb, _s, _o, _so) => {
      // Fire the signal after the first fork lands so the pool stops
      // claiming subsequent fork indices.
      ac.abort();
      await new Promise((r) => setTimeout(r, 1));
      return shadowResult();
    });

    const batch = await dispatchForks(
      makeClient(),
      makeCallbacks(),
      baseOptions({ numForks: 5, maxConcurrent: 1, signal: ac.signal }),
    );

    const aborted = batch.results.filter((r) => r.errorMessage === 'aborted-before-start');
    expect(aborted.length).toBeGreaterThan(0);
    for (const r of aborted) {
      expect(r.success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Callback tagging
// ---------------------------------------------------------------------------

describe('dispatchForks — callback tagging', () => {
  it('prefixes tool-call + tool-result events with the fork id so events are routable per fork', async () => {
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, callbacks) => {
      // Simulate the agent loop calling a tool mid-run.
      callbacks.onToolCall?.('read_file', { path: 'src/x.ts' }, 'tu-1');
      callbacks.onToolResult?.('read_file', 'content', false, 'tu-1');
      return shadowResult();
    });

    const callbacks = makeCallbacks();
    await dispatchForks(makeClient(), callbacks, baseOptions({ numForks: 2 }));

    // Every tool-call/tool-result must be prefixed with fork-<n>:.
    for (const name of callbacks.toolCalls) {
      expect(name).toMatch(/^fork-\d+:read_file$/);
    }
    // One call per fork → 2 entries in each array.
    expect(callbacks.toolCalls).toHaveLength(2);
    expect(callbacks.toolResults).toHaveLength(2);
  });

  it('forwards raw text from each fork to the parent unchanged', async () => {
    runAgentLoopInSandboxMock.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onText?.('fork-text');
      return shadowResult();
    });

    const callbacks = makeCallbacks();
    await dispatchForks(makeClient(), callbacks, baseOptions({ numForks: 2 }));

    const forkTexts = callbacks.texts.filter((t) => t === 'fork-text');
    expect(forkTexts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('dispatchForks — labels', () => {
  it('defaults labels to "Fork 1", "Fork 2", etc. when none are supplied', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());
    const batch = await dispatchForks(makeClient(), makeCallbacks(), baseOptions({ numForks: 3 }));
    expect(batch.results.map((r) => r.label)).toEqual(['Fork 1', 'Fork 2', 'Fork 3']);
  });

  it('uses caller-supplied labels when length matches numForks', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());
    const batch = await dispatchForks(
      makeClient(),
      makeCallbacks(),
      baseOptions({ numForks: 2, labels: ['Opus approach', 'Sonnet approach'] }),
    );
    expect(batch.results.map((r) => r.label)).toEqual(['Opus approach', 'Sonnet approach']);
  });

  it('falls back to default labels when caller-supplied length mismatches numForks', async () => {
    runAgentLoopInSandboxMock.mockResolvedValue(shadowResult());
    const batch = await dispatchForks(
      makeClient(),
      makeCallbacks(),
      baseOptions({ numForks: 3, labels: ['only-one'] }),
    );
    expect(batch.results.map((r) => r.label)).toEqual(['Fork 1', 'Fork 2', 'Fork 3']);
  });
});
