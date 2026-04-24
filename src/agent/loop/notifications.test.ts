import { describe, it, expect, vi } from 'vitest';
import { notifyIterationStart, maybeEmitProgressSummary, shouldStopAtCheckpoint } from './notifications.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { getConfig } from '../../config/settings.js';

// ---------------------------------------------------------------------------
// Tests for notifications.ts (v0.65 chunk 2a — loop helper hardening).
//
// Three pure-ish helpers that fire `onIterationStart` /
// `onProgressSummary` / `onCheckpoint` callbacks. No real vscode / LLM
// dependencies — tests drive observable outputs via stubbed callbacks
// and a minimal `LoopState` slice.
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

function stubCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
}

function stubConfig(agentMaxMessages = 100): ReturnType<typeof getConfig> {
  return { agentMaxMessages } as unknown as ReturnType<typeof getConfig>;
}

describe('notifyIterationStart', () => {
  it('fires onIterationStart with every field the webview consumes', () => {
    const onIterationStart = vi.fn();
    const state = stubState({
      iteration: 7,
      messages: Array(30).fill({ role: 'user', content: 'x' }) as LoopState['messages'],
      totalChars: 40_000, // ~10K tokens via CHARS_PER_TOKEN=4
    });
    const cb = stubCallbacks({ onIterationStart });
    notifyIterationStart(state, stubConfig(100), cb);

    expect(onIterationStart).toHaveBeenCalledOnce();
    const payload = onIterationStart.mock.calls[0][0] as {
      iteration: number;
      maxIterations: number;
      elapsedMs: number;
      estimatedTokens: number;
      messageCount: number;
      messagesRemaining: number;
      atCapacity: boolean;
    };
    expect(payload.iteration).toBe(7);
    expect(payload.maxIterations).toBe(25);
    expect(payload.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(payload.estimatedTokens).toBe(10_000);
    expect(payload.messageCount).toBe(30);
    expect(payload.messagesRemaining).toBe(70);
    expect(payload.atCapacity).toBe(false);
  });

  it('clamps messagesRemaining at 0 and flips atCapacity when at/over the ceiling', () => {
    const onIterationStart = vi.fn();
    const state = stubState({
      messages: Array(100).fill({ role: 'user', content: 'x' }) as LoopState['messages'],
    });
    notifyIterationStart(state, stubConfig(100), stubCallbacks({ onIterationStart }));

    const payload = onIterationStart.mock.calls[0][0] as { messagesRemaining: number; atCapacity: boolean };
    expect(payload.messagesRemaining).toBe(0);
    expect(payload.atCapacity).toBe(true);
  });

  it('no-ops silently when the callback is undefined', () => {
    // Just ensure no throw; there's no observable side effect.
    expect(() => notifyIterationStart(stubState(), stubConfig(100), stubCallbacks())).not.toThrow();
  });
});

describe('maybeEmitProgressSummary', () => {
  it('stays quiet for iteration 1 (rate-limit — no 0% messages on short runs)', () => {
    const onProgressSummary = vi.fn();
    maybeEmitProgressSummary(stubState({ iteration: 1 }), stubCallbacks({ onProgressSummary }));
    expect(onProgressSummary).not.toHaveBeenCalled();
  });

  it('stays quiet for iterations that are not multiples of 5', () => {
    const onProgressSummary = vi.fn();
    for (const it of [2, 3, 4, 6, 7, 11, 13]) {
      maybeEmitProgressSummary(stubState({ iteration: it }), stubCallbacks({ onProgressSummary }));
    }
    expect(onProgressSummary).not.toHaveBeenCalled();
  });

  it('fires on iteration 5, 10, 15, …', () => {
    const onProgressSummary = vi.fn();
    for (const it of [5, 10, 15, 20]) {
      maybeEmitProgressSummary(stubState({ iteration: it }), stubCallbacks({ onProgressSummary }));
    }
    expect(onProgressSummary).toHaveBeenCalledTimes(4);
  });

  it('includes iteration ratio, elapsed seconds, % context, and message count in the summary', () => {
    const onProgressSummary = vi.fn();
    const state = stubState({
      iteration: 10,
      maxIterations: 25,
      totalChars: 200_000, // 50K tokens on maxTokens 100K → 50%
      messages: Array(12).fill({ role: 'user', content: 'x' }) as LoopState['messages'],
    });
    maybeEmitProgressSummary(state, stubCallbacks({ onProgressSummary }));
    expect(onProgressSummary).toHaveBeenCalledOnce();
    const message = onProgressSummary.mock.calls[0][0] as string;
    expect(message).toContain('10/25');
    expect(message).toMatch(/\d+s elapsed/);
    expect(message).toContain('50% context');
    expect(message).toContain('12 messages');
  });

  it('no-ops when onProgressSummary callback is undefined even on a fire iteration', () => {
    // Ensure no throw — iteration is 5 but callback is undefined.
    expect(() => maybeEmitProgressSummary(stubState({ iteration: 5 }), stubCallbacks())).not.toThrow();
  });
});

describe('shouldStopAtCheckpoint', () => {
  it('returns false when onCheckpoint is undefined', async () => {
    const state = stubState({ iteration: 15, maxIterations: 25 }); // 60% of 25 = 15
    expect(await shouldStopAtCheckpoint(state, stubCallbacks())).toBe(false);
  });

  it('returns false when we are not at the 60% boundary', async () => {
    const onCheckpoint = vi.fn().mockResolvedValue(true);
    const state = stubState({ iteration: 10, maxIterations: 25 }); // 60% is 15
    expect(await shouldStopAtCheckpoint(state, stubCallbacks({ onCheckpoint }))).toBe(false);
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('stays quiet on short runs where iteration <= 3', async () => {
    const onCheckpoint = vi.fn().mockResolvedValue(true);
    // maxIterations=5, 60% = 3 → iteration 3 hits boundary but <= 3 guard should silence
    const state = stubState({ iteration: 3, maxIterations: 5 });
    expect(await shouldStopAtCheckpoint(state, stubCallbacks({ onCheckpoint }))).toBe(false);
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('at the 60% boundary, delegates to onCheckpoint and returns false when user continues', async () => {
    const onCheckpoint = vi.fn().mockResolvedValue(true);
    const state = stubState({ iteration: 15, maxIterations: 25 });
    expect(await shouldStopAtCheckpoint(state, stubCallbacks({ onCheckpoint }))).toBe(false);
    expect(onCheckpoint).toHaveBeenCalledOnce();
    const args = onCheckpoint.mock.calls[0];
    expect(args[0]).toContain('Reached iteration 15 of 25');
    expect(args[1]).toBe(15);
    expect(args[2]).toBe(10); // maxIterations - iteration
  });

  it('returns true and emits "Stopped at checkpoint" when user declines', async () => {
    const onCheckpoint = vi.fn().mockResolvedValue(false);
    const onText = vi.fn();
    const state = stubState({ iteration: 15, maxIterations: 25 });
    expect(await shouldStopAtCheckpoint(state, stubCallbacks({ onCheckpoint, onText }))).toBe(true);
    expect(onText).toHaveBeenCalledWith(expect.stringContaining('Stopped at checkpoint'));
  });

  it('logs the decision via state.logger.info when the user stops', async () => {
    const info = vi.fn();
    const state = stubState({
      iteration: 15,
      maxIterations: 25,
      logger: { info, warn: vi.fn() } as unknown as LoopState['logger'],
    });
    await shouldStopAtCheckpoint(state, stubCallbacks({ onCheckpoint: vi.fn().mockResolvedValue(false) }));
    expect(info).toHaveBeenCalledWith('User stopped at checkpoint');
  });
});
