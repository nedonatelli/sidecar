import { describe, it, expect } from 'vitest';
import { checkToolBudget, recordToolUse } from './toolBudget.js';
import type { LoopState } from './state.js';
import { resolveScaffoldingProfile } from '../scaffoldingProfile.js';
import type { AgentDecision } from '../decisions.js';

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

describe('checkToolBudget with a scaffolding profile', () => {
  function stateWith(overrides: Partial<LoopState>): LoopState {
    return { toolCallCounts: new Map<string, number>(), ...overrides } as LoopState;
  }
  const fill = (state: LoopState, tool: string, n: number) => {
    for (let i = 0; i < n; i++) recordToolUse(state, tool);
  };

  it("reads the strong tier's budget instead of the medium constant", () => {
    const state = stateWith({ scaffoldingProfile: resolveScaffoldingProfile('strong') });
    fill(state, 'run_command', 15);
    expect(checkToolBudget(state, 'run_command')).toBeNull();
    fill(state, 'run_command', 45);
    expect(checkToolBudget(state, 'run_command')).toContain('budget: 60');
  });

  it('falls back to the default budget for a tool the profile does not list', () => {
    const state = stateWith({ scaffoldingProfile: resolveScaffoldingProfile('strong') });
    fill(state, 'custom_tool', 20);
    expect(checkToolBudget(state, 'custom_tool')).toContain('budget: 20');
  });

  it('does not point an autonomous run at ask_user, which nobody answers', () => {
    const autonomous = stateWith({ approvalMode: 'autonomous' });
    fill(autonomous, 'web_search', 5);
    const msg = checkToolBudget(autonomous, 'web_search');
    expect(msg).not.toContain('ask_user');
    expect(msg).toContain('autonomous');

    const cautious = stateWith({ approvalMode: 'cautious' });
    fill(cautious, 'web_search', 5);
    expect(checkToolBudget(cautious, 'web_search')).toContain('ask_user');
  });

  it('records each refusal as a structured decision', () => {
    const decisions: AgentDecision[] = [];
    const logger = { logDecision: (d: AgentDecision) => decisions.push(d), warn: () => {} };
    const state = stateWith({ logger: logger as unknown as LoopState['logger'] });
    fill(state, 'grep', 15);
    checkToolBudget(state, 'grep');
    expect(decisions).toEqual([{ kind: 'tool_budget', action: 'refused', tool: 'grep', count: 15, budget: 15 }]);
  });

  it('records nothing for an allowed call', () => {
    const decisions: AgentDecision[] = [];
    const logger = { logDecision: (d: AgentDecision) => decisions.push(d) };
    checkToolBudget(stateWith({ logger: logger as unknown as LoopState['logger'] }), 'grep');
    expect(decisions).toEqual([]);
  });
});
