import { describe, it, expect } from 'vitest';
import { checkToolBudget, recordToolUse } from './toolBudget.js';
import type { LoopState } from './state.js';

function makeState(): Pick<LoopState, 'toolCallCounts'> {
  return { toolCallCounts: new Map<string, number>() };
}

describe('checkToolBudget', () => {
  it('allows a tool call within budget', () => {
    const state = makeState();
    expect(checkToolBudget(state as LoopState, 'grep')).toBeNull();
    // check does NOT increment — recordToolUse does
    expect(state.toolCallCounts.get('grep')).toBeUndefined();
  });

  it('recordToolUse increments count on each call', () => {
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      recordToolUse(state as LoopState, 'read_file');
    }
    expect(state.toolCallCounts.get('read_file')).toBe(5);
  });

  it('returns an error when a known tool exceeds its budget', () => {
    const state = makeState();
    // grep budget is 15 — record 15 uses first
    for (let i = 0; i < 15; i++) {
      expect(checkToolBudget(state as LoopState, 'grep')).toBeNull();
      recordToolUse(state as LoopState, 'grep');
    }
    const err = checkToolBudget(state as LoopState, 'grep');
    expect(err).not.toBeNull();
    expect(err).toContain('grep');
    expect(err).toContain('15');
    // Counter should stay at 15 (budget exceeded check does not increment)
    expect(state.toolCallCounts.get('grep')).toBe(15);
  });

  it('returns an error when an unknown tool exceeds the default budget of 20', () => {
    const state = makeState();
    for (let i = 0; i < 20; i++) {
      expect(checkToolBudget(state as LoopState, 'custom_tool')).toBeNull();
      recordToolUse(state as LoopState, 'custom_tool');
    }
    const err = checkToolBudget(state as LoopState, 'custom_tool');
    expect(err).not.toBeNull();
    expect(err).toContain('custom_tool');
    expect(err).toContain('20');
  });

  it('tracks tools independently', () => {
    const state = makeState();
    for (let i = 0; i < 10; i++) {
      recordToolUse(state as LoopState, 'grep');
      recordToolUse(state as LoopState, 'read_file');
    }
    expect(state.toolCallCounts.get('grep')).toBe(10);
    expect(state.toolCallCounts.get('read_file')).toBe(10);
    // Both should still be within their budgets
    expect(checkToolBudget(state as LoopState, 'grep')).toBeNull();
    expect(checkToolBudget(state as LoopState, 'read_file')).toBeNull();
  });

  it('web_search has a low budget of 5', () => {
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      expect(checkToolBudget(state as LoopState, 'web_search')).toBeNull();
      recordToolUse(state as LoopState, 'web_search');
    }
    expect(checkToolBudget(state as LoopState, 'web_search')).not.toBeNull();
  });

  it('budget-exceeded check does not consume budget (user-denied tools stay within limit)', () => {
    const state = makeState();
    // Only record actual executions
    for (let i = 0; i < 5; i++) {
      expect(checkToolBudget(state as LoopState, 'web_search')).toBeNull();
      recordToolUse(state as LoopState, 'web_search');
    }
    // At budget — check returns error but does not increment
    const err = checkToolBudget(state as LoopState, 'web_search');
    expect(err).not.toBeNull();
    expect(state.toolCallCounts.get('web_search')).toBe(5);
    // Check again — still returns error, count still 5
    expect(checkToolBudget(state as LoopState, 'web_search')).not.toBeNull();
    expect(state.toolCallCounts.get('web_search')).toBe(5);
  });
});
