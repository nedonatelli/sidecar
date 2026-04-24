import { describe, it, expect, vi } from 'vitest';
import { drainSteerQueueAtBoundary } from './steerDrain.js';
import { SteerQueue } from '../steerQueue.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';

// ---------------------------------------------------------------------------
// Tests for steerDrain.ts (v0.65 chunk 3.2b).
//
// drainSteerQueueAtBoundary() is the iteration-boundary hook that:
//   1. no-ops when queue is undefined or empty,
//   2. honors the coalesce window (delays drain while the newest steer
//      is still inside the window — gives the user a chance to follow
//      up without fragmenting intent across two turns),
//   3. pushes a single coalesced user message onto state.messages,
//   4. bumps state.totalChars,
//   5. emits a breadcrumb via onText,
//   6. returns early on aborted signal without draining.
// ---------------------------------------------------------------------------

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    runId: 'test-task',
    config: {} as import('../../config/settings.js').SideCarConfig,
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: undefined,
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

function stubCallbacks(): AgentCallbacks & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    onText: (t: string) => texts.push(t),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

describe('drainSteerQueueAtBoundary — no-op paths', () => {
  it('no-ops when queue is undefined', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    await drainSteerQueueAtBoundary(state, undefined, new AbortController().signal, cb, { coalesceWindowMs: 0 });
    expect(state.messages).toHaveLength(0);
    expect(cb.texts).toHaveLength(0);
  });

  it('no-ops when queue is empty', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const q = new SteerQueue();
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, { coalesceWindowMs: 0 });
    expect(state.messages).toHaveLength(0);
  });
});

describe('drainSteerQueueAtBoundary — drain happy path', () => {
  it('pushes a single user message and bumps totalChars', async () => {
    const state = stubState({ totalChars: 100 });
    const cb = stubCallbacks();
    const q = new SteerQueue({ now: () => 1000 });
    q.enqueue('focus on the formula', 'nudge');
    q.enqueue('ignore the numpy path', 'nudge');
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, {
      coalesceWindowMs: 0, // no window → drain immediately
      now: () => 2000,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[0].content).toContain('Your running instructions');
    expect(state.totalChars).toBeGreaterThan(100);
    expect(q.size()).toBe(0);
  });

  it('emits a breadcrumb with the count', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const q = new SteerQueue();
    q.enqueue('a', 'nudge');
    q.enqueue('b', 'nudge');
    q.enqueue('c', 'interrupt');
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, { coalesceWindowMs: 0 });
    expect(cb.texts).toHaveLength(1);
    expect(cb.texts[0]).toContain('3 queued steers');
  });

  it('uses singular "steer" when exactly one item drains', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const q = new SteerQueue();
    q.enqueue('solo', 'nudge');
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, { coalesceWindowMs: 0 });
    expect(cb.texts[0]).toContain('1 queued steer.');
    expect(cb.texts[0]).not.toContain('steers');
  });
});

describe('drainSteerQueueAtBoundary — coalesce window', () => {
  it('waits out the remaining window when the newest steer is fresh', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      // advance the clock by the requested sleep amount
      clock += ms;
    });
    let clock = 2000;
    const q = new SteerQueue({ now: () => clock });
    q.enqueue('fresh', 'nudge'); // createdAt = 2000
    clock = 2500; // 500ms elapsed → 1500ms remaining in window
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, {
      coalesceWindowMs: 2000,
      now: () => clock,
      sleep,
    });
    // Eventual drain — queue cleared, message pushed.
    expect(q.size()).toBe(0);
    expect(state.messages).toHaveLength(1);
    // Slept at least once while window was open.
    expect(sleep).toHaveBeenCalled();
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1500);
  });

  it('does not sleep when coalesceWindowMs is 0', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const sleep = vi.fn();
    const q = new SteerQueue();
    q.enqueue('a', 'nudge');
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, {
      coalesceWindowMs: 0,
      sleep,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(1);
  });

  it('does not sleep when the newest steer is already past the window', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const sleep = vi.fn();
    const q = new SteerQueue({ now: () => 1000 });
    q.enqueue('a', 'nudge'); // createdAt = 1000
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, {
      coalesceWindowMs: 500,
      now: () => 5000, // 4000ms elapsed, window long passed
      sleep,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(state.messages).toHaveLength(1);
  });

  it('bails early when signal aborts during the coalesce wait — leaves queue untouched', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const ctrl = new AbortController();
    const sleep = vi.fn(async () => {
      ctrl.abort();
    });
    const clock = 1000;
    const q = new SteerQueue({ now: () => clock });
    q.enqueue('will-survive', 'nudge');
    await drainSteerQueueAtBoundary(state, q, ctrl.signal, cb, {
      coalesceWindowMs: 5000,
      now: () => clock,
      sleep,
    });
    expect(q.size()).toBe(1); // drain was skipped
    expect(state.messages).toHaveLength(0);
  });

  it('handles cancellation mid-wait by re-peeking and early-return', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const q = new SteerQueue({ now: () => 0 });
    q.enqueue('will-be-cancelled', 'nudge');
    const clock = 0;
    const sleep = vi.fn(async () => {
      // User cancelled while we slept.
      q.clear();
    });
    await drainSteerQueueAtBoundary(state, q, new AbortController().signal, cb, {
      coalesceWindowMs: 5000,
      now: () => clock,
      sleep,
    });
    expect(state.messages).toHaveLength(0);
    expect(cb.texts).toHaveLength(0);
  });
});
