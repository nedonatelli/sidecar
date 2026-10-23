import { describe, it, expect } from 'vitest';
import { checkToolBudget, recordToolUse, toolBudgetFor, baseToolBudget } from './toolBudget.js';
import { resolveScaffoldingProfile } from '../scaffoldingProfile.js';
import type { LoopState } from './state.js';
import type { AgentDecision } from '../decisions.js';

function makeState(): Pick<LoopState, 'toolCallCounts' | 'scaffoldingProfile'> {
  return { toolCallCounts: new Map<string, number>() };
}

function spend(state: Pick<LoopState, 'toolCallCounts'>, tool: string, n: number) {
  for (let i = 0; i < n; i++) recordToolUse(state as LoopState, tool);
}

// #236: claude-haiku-4-5 hit a budget on 40/50 SWE canary tasks.
describe('tool budgets per tier (#236)', () => {
  it('medium and weak keep the historical budgets; so does a run with no profile', () => {
    for (const tool of ['run_command', 'read_file', 'grep', 'web_search', 'some_unlisted_tool']) {
      for (const tier of ['medium', 'weak'] as const) {
        const state = { ...makeState(), scaffoldingProfile: resolveScaffoldingProfile(tier) } as LoopState;
        expect(toolBudgetFor(state, tool)).toBe(baseToolBudget(tool));
      }
      expect(toolBudgetFor(makeState() as LoopState, tool)).toBe(baseToolBudget(tool));
    }
    expect(baseToolBudget('run_command')).toBe(15);
    expect(baseToolBudget('some_unlisted_tool')).toBe(20);
  });

  it('strong lifts the five measured tools and leaves the rest', () => {
    const strong = { ...makeState(), scaffoldingProfile: resolveScaffoldingProfile('strong') } as LoopState;
    const want = { run_command: 60, read_file: 50, grep: 40, search_files: 40, list_directory: 20 };
    for (const [tool, budget] of Object.entries(want)) expect(toolBudgetFor(strong, tool)).toBe(budget);
    expect(toolBudgetFor(strong, 'write_file')).toBe(baseToolBudget('write_file'));
  });

  it("sidecar.scaffolding.overrides.toolBudgets pins one tool and keeps the tier's others", () => {
    const profile = resolveScaffoldingProfile('strong', { toolBudgets: { run_command: 30 } });
    const state = { ...makeState(), scaffoldingProfile: profile } as LoopState;
    expect(toolBudgetFor(state, 'run_command')).toBe(30);
    expect(toolBudgetFor(state, 'read_file')).toBe(50);
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
    // A fresh state: a second refusal of the same tool gets the repeat wording (#268).
    const fresh = makeState();
    spend(fresh, 'run_command', 15);
    expect(checkToolBudget(fresh as LoopState, 'run_command', { canAskUser: false })).toBe(msg);
  });

  it('with a clarification UI it keeps the ask_user route', () => {
    const state = makeState();
    spend(state, 'run_command', 15);
    expect(checkToolBudget(state as LoopState, 'run_command', { canAskUser: true })).toContain('ask_user');
  });
});

// #268: 78% of 351 SWE canary runs that hit a budget called the refused tool
// again, about five times each, and got the same words back each time (e4b,
// pytest-5692: run_command refused at 15/15, then asked for 5 more times until
// the iteration ceiling).
describe('a repeated call to a spent tool (#268)', () => {
  const tools = (...names: string[]) => names.map((name) => ({ name, description: '', input_schema: {} }));

  it('the second refusal differs from the first, names alternatives, and says when to stop', () => {
    const state = {
      ...makeState(),
      tools: tools('run_command', 'run_tests', 'read_file', 'grep'),
    } as unknown as LoopState;
    spend(state, 'run_command', 15);
    const first = checkToolBudget(state, 'run_command')!;
    const second = checkToolBudget(state, 'run_command')!;
    expect(second).not.toBe(first);
    expect(second).toContain('refused again (refusal 2)');
    expect(second).toContain('run_tests for a test command');
    expect(second).toContain('give your final answer');
    expect(checkToolBudget(state, 'run_command')).toContain('refusal 3');
  });

  it('names only alternatives the run has and can still call', () => {
    const state = { ...makeState(), tools: tools('run_command', 'read_file', 'grep') } as unknown as LoopState;
    spend(state, 'run_command', 15);
    spend(state, 'grep', 15); // grep is spent too
    checkToolBudget(state, 'run_command');
    const second = checkToolBudget(state, 'run_command')!;
    expect(second).not.toContain('run_tests'); // not in this run
    expect(second).not.toContain('grep to search'); // spent
    expect(second).toContain('read_file to look at a file');
  });

  it('with nothing to suggest it still says to stop and answer', () => {
    const state = { ...makeState(), tools: tools('web_search') } as unknown as LoopState;
    spend(state, 'web_search', 5);
    checkToolBudget(state, 'web_search');
    const second = checkToolBudget(state, 'web_search')!;
    expect(second).not.toContain('Instead');
    expect(second).toContain('give your final answer');
  });

  it('counts each tool separately', () => {
    const state = makeState() as LoopState;
    spend(state, 'run_command', 15);
    spend(state, 'grep', 15);
    checkToolBudget(state, 'run_command');
    expect(checkToolBudget(state, 'grep')).not.toContain('refused again');
  });

  it('keeps the ask_user route on a repeat when someone can answer', () => {
    const state = makeState() as LoopState;
    spend(state, 'run_command', 15);
    checkToolBudget(state, 'run_command', { canAskUser: true });
    expect(checkToolBudget(state, 'run_command', { canAskUser: true })).toContain('ask_user');
    const noUi = makeState() as LoopState;
    spend(noUi, 'run_command', 15);
    checkToolBudget(noUi, 'run_command');
    expect(checkToolBudget(noUi, 'run_command')).not.toContain('ask_user');
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

  it('the refusal offers ask_user only when a clarification UI can answer, whatever the approval mode', () => {
    // Keyed on the UI, not the mode: the extension's autonomous mode still has a
    // person at the chat panel, and a headless run has no one in any mode.
    const autonomous = stateWith({ approvalMode: 'autonomous' });
    fill(autonomous, 'web_search', 5);
    expect(checkToolBudget(autonomous, 'web_search')).not.toContain('ask_user');
    expect(checkToolBudget(autonomous, 'web_search', { canAskUser: true })).toContain('ask_user');

    const cautious = stateWith({ approvalMode: 'cautious' });
    fill(cautious, 'web_search', 5);
    expect(checkToolBudget(cautious, 'web_search')).not.toContain('ask_user');
    expect(checkToolBudget(cautious, 'web_search', { canAskUser: true })).toContain('ask_user');
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
