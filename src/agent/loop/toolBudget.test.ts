import { describe, it, expect } from 'vitest';
import { checkToolBudget, recordToolUse, toolBudgetFor, baseToolBudget } from './toolBudget.js';
import { resolveScaffoldingProfile } from '../scaffoldingProfile.js';
import type { LoopState } from './state.js';

function makeState(): Pick<LoopState, 'toolCallCounts' | 'scaffoldingProfile'> {
  return { toolCallCounts: new Map<string, number>() };
}

function spend(state: Pick<LoopState, 'toolCallCounts'>, tool: string, n: number) {
  for (let i = 0; i < n; i++) recordToolUse(state as LoopState, tool);
}

// #236: claude-haiku-4-5 hit a budget on 40/50 SWE canary tasks.
describe('tool budgets per tier (#236)', () => {
  it('strong gets 3× every budget; medium and weak keep the historical ones', () => {
    for (const tool of ['run_command', 'read_file', 'grep', 'web_search', 'some_unlisted_tool']) {
      const at = (tier: 'strong' | 'medium' | 'weak') =>
        toolBudgetFor({ ...makeState(), scaffoldingProfile: resolveScaffoldingProfile(tier) } as LoopState, tool);
      expect(at('strong')).toBe(baseToolBudget(tool) * 3);
      expect(at('medium')).toBe(baseToolBudget(tool));
      expect(at('weak')).toBe(baseToolBudget(tool));
    }
    expect(baseToolBudget('run_command')).toBe(15);
  });

  it('no profile (adaptive scaffolding off) is the historical budget', () => {
    expect(toolBudgetFor(makeState() as LoopState, 'run_command')).toBe(15);
  });

  it('a strong-tier run_command is refused at 45, not 15', () => {
    const state = { ...makeState(), scaffoldingProfile: resolveScaffoldingProfile('strong') };
    spend(state, 'run_command', 15);
    expect(checkToolBudget(state as LoopState, 'run_command')).toBeNull();
    spend(state, 'run_command', 30);
    expect(checkToolBudget(state as LoopState, 'run_command')).toContain('budget: 45');
  });

  it('sidecar.scaffolding.overrides can pin the multiplier', () => {
    const state = {
      ...makeState(),
      scaffoldingProfile: resolveScaffoldingProfile('medium', { toolBudgetMultiplier: 2 }),
    };
    expect(toolBudgetFor(state as LoopState, 'grep')).toBe(30);
  });
});

describe('the refusal message only offers ask_user when someone can answer (#236)', () => {
  it('with no clarification UI it says to use what was gathered, and never names ask_user', () => {
    const state = makeState();
    spend(state, 'run_command', 15);
    const msg = checkToolBudget(state as LoopState, 'run_command')!;
    expect(msg).not.toContain('ask_user');
    expect(msg).toContain('Work with what you have already gathered');
    // The default is the no-UI wording: a caller that says nothing is not promised a human.
    expect(checkToolBudget(state as LoopState, 'run_command', { canAskUser: false })).toBe(msg);
  });

  it('with a clarification UI it keeps the ask_user route', () => {
    const state = makeState();
    spend(state, 'run_command', 15);
    expect(checkToolBudget(state as LoopState, 'run_command', { canAskUser: true })).toContain('ask_user');
  });
});

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
