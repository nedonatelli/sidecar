import { describe, it, expect, vi } from 'vitest';
import { exceedsBurstCap, detectCycleAndBail } from './cycleDetection.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for cycleDetection.ts (v0.65 chunk 2a — loop helper hardening).
//
// Both exports (`exceedsBurstCap` and `detectCycleAndBail`) are pure
// functions over `ToolUseContentBlock[]` + a minimal LoopState slice +
// an AgentCallbacks shim. No real LLM / vscode / fs dependencies, so
// tests run synchronously in a few ms each.
//
// Branch coverage targets:
//   - burst cap: at/below/above MAX_TOOL_CALLS_PER_ITERATION
//   - cycle: no cycle, length-1 with < min repeats, length-1 at min repeats,
//            length-2 cycle, length-3 cycle, length-4 cycle, > MAX_CYCLE_LEN
//            (should NOT fire), ring buffer pruning at CYCLE_WINDOW edge
// ---------------------------------------------------------------------------

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}-${JSON.stringify(input)}`, name, input };
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

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  // Minimal stub — cycle/burst helpers read `recentToolCalls` + `logger`.
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

describe('exceedsBurstCap', () => {
  it('returns false for an empty tool-use batch', () => {
    const state = stubState();
    const cb = stubCallbacks();
    expect(exceedsBurstCap([], state, cb)).toBe(false);
    expect(cb.texts).toHaveLength(0);
  });

  it('returns false at exactly MAX_TOOL_CALLS_PER_ITERATION (12) — the cap is inclusive', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => makeToolUse(`t${i}`));
    const state = stubState();
    const cb = stubCallbacks();
    expect(exceedsBurstCap(twelve, state, cb)).toBe(false);
    expect(cb.texts).toHaveLength(0);
  });

  it('returns true at 13 tool calls and surfaces a user-visible warning', () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => makeToolUse(`t${i}`));
    const state = stubState();
    const cb = stubCallbacks();
    expect(exceedsBurstCap(thirteen, state, cb)).toBe(true);
    expect(cb.texts).toHaveLength(1);
    expect(cb.texts[0]).toContain('13 tool calls');
    expect(cb.texts[0]).toContain('burst cap');
  });

  it('logs the burst via state.logger when present', () => {
    const warn = vi.fn();
    const state = stubState({ logger: { warn } as unknown as LoopState['logger'] });
    const cb = stubCallbacks();
    const big = Array.from({ length: 20 }, (_, i) => makeToolUse(`read_file`, { path: `f${i}.ts` }));
    exceedsBurstCap(big, state, cb);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('20 tool calls');
    expect(warn.mock.calls[0][0]).toContain('read_file');
  });
});

describe('detectCycleAndBail', () => {
  it('returns false and pushes the signature when the ring is empty', () => {
    const state = stubState();
    const cb = stubCallbacks();
    expect(detectCycleAndBail([makeToolUse('read_file', { path: 'a.ts' })], state, cb)).toBe(false);
    expect(state.recentToolCalls).toHaveLength(1);
  });

  it('returns false when the ring contains 3 identical signatures (below MIN_IDENTICAL_REPEATS=4)', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const call = [makeToolUse('ls', { dir: '.' })];
    for (let i = 0; i < 3; i++) {
      expect(detectCycleAndBail(call, state, cb)).toBe(false);
    }
    expect(cb.texts).toHaveLength(0);
  });

  it('returns true when the same signature fires 4 times (length-1 cycle at MIN_IDENTICAL_REPEATS)', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const call = [makeToolUse('ls', { dir: '.' })];
    let bailed = false;
    for (let i = 0; i < 4; i++) {
      bailed = detectCycleAndBail(call, state, cb);
    }
    expect(bailed).toBe(true);
    expect(cb.texts[0]).toContain('4 times');
  });

  it('distinguishes different inputs for the same tool name', () => {
    const state = stubState();
    const cb = stubCallbacks();
    for (let i = 0; i < 4; i++) {
      const decision = detectCycleAndBail([makeToolUse('read_file', { path: `f${i}.ts` })], state, cb);
      expect(decision).toBe(false); // each call has a distinct signature
    }
    expect(state.recentToolCalls).toHaveLength(4);
  });

  it('detects a length-2 A,B,A,B cycle on the first full repetition', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const A = [makeToolUse('read_file', { path: 'a.ts' })];
    const B = [makeToolUse('read_file', { path: 'b.ts' })];
    expect(detectCycleAndBail(A, state, cb)).toBe(false); // [A]
    expect(detectCycleAndBail(B, state, cb)).toBe(false); // [A,B]
    expect(detectCycleAndBail(A, state, cb)).toBe(false); // [A,B,A]
    expect(detectCycleAndBail(B, state, cb)).toBe(true); //  [A,B,A,B] — cycle
    expect(cb.texts[0]).toContain('length 2');
  });

  it('detects a length-3 cycle (A,B,C,A,B,C)', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const A = [makeToolUse('a')];
    const B = [makeToolUse('b')];
    const C = [makeToolUse('c')];
    for (const c of [A, B, C, A, B]) expect(detectCycleAndBail(c, state, cb)).toBe(false);
    expect(detectCycleAndBail(C, state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('length 3');
  });

  it('detects a length-4 cycle (A,B,C,D,A,B,C,D)', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const A = [makeToolUse('a')];
    const B = [makeToolUse('b')];
    const C = [makeToolUse('c')];
    const D = [makeToolUse('d')];
    for (const c of [A, B, C, D, A, B, C]) expect(detectCycleAndBail(c, state, cb)).toBe(false);
    expect(detectCycleAndBail(D, state, cb)).toBe(true);
    expect(cb.texts[0]).toContain('length 4');
  });

  it('does NOT fire on a length-5 pattern (MAX_CYCLE_LEN=4)', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const seq = ['a', 'b', 'c', 'd', 'e'].map((n) => [makeToolUse(n)]);
    // Pattern ABCDE,ABCDE has length 5 — above MAX_CYCLE_LEN. The ring
    // buffer trims at CYCLE_WINDOW=8 so we never see two full copies
    // of a length-5 pattern anyway (would need 10 slots). Confirm no
    // bail fires throughout.
    for (const call of [...seq, ...seq]) {
      expect(detectCycleAndBail(call, state, cb)).toBe(false);
    }
  });

  it('trims the ring buffer at CYCLE_WINDOW=8 entries', () => {
    const state = stubState();
    const cb = stubCallbacks();
    for (let i = 0; i < 10; i++) {
      detectCycleAndBail([makeToolUse(`t${i}`)], state, cb);
    }
    expect(state.recentToolCalls).toHaveLength(8);
    // Oldest entries dropped.
    expect(state.recentToolCalls[0]).toContain('t2:');
    expect(state.recentToolCalls[7]).toContain('t9:');
  });

  it('handles multi-tool-call turns by joining signatures with |', () => {
    // A turn that calls read_file + grep in one iteration has a
    // composite signature. Two such turns in a row = length-1 cycle?
    // No — need 4 for length-1. But A,B cycle works with composites.
    const state = stubState();
    const cb = stubCallbacks();
    const turn1 = [makeToolUse('read_file', { path: 'a' }), makeToolUse('grep', { pattern: 'x' })];
    const turn2 = [makeToolUse('ls', { dir: '.' })];
    expect(detectCycleAndBail(turn1, state, cb)).toBe(false);
    expect(detectCycleAndBail(turn2, state, cb)).toBe(false);
    expect(detectCycleAndBail(turn1, state, cb)).toBe(false);
    expect(detectCycleAndBail(turn2, state, cb)).toBe(true); // length-2 cycle
    expect(cb.texts[0]).toContain('length 2');
  });
});
