import { describe, it, expect } from 'vitest';
import { checkToolBudget, recordToolUse, toolBudgetFor, baseToolBudget, FAILED_EDIT_FACTOR } from './toolBudget.js';
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

// #268: a failed edit_file call changed nothing, so it must not spend the edit budget.
describe('edit_file budget counts applied edits (#268)', () => {
  const budget = baseToolBudget('edit_file');
  const fail = (state: Pick<LoopState, 'toolCallCounts'>, n: number) => {
    for (let i = 0; i < n; i++) recordToolUse(state as LoopState, 'edit_file', { failed: true });
  };

  it('failed edits do not spend the budget, and applied ones do', () => {
    const state = makeState();
    fail(state, budget - 1);
    spend(state, 'edit_file', budget - 1);
    expect(checkToolBudget(state as LoopState, 'edit_file')).toBeNull();
    expect(state.toolCallCounts.get('edit_file')).toBe(budget - 1);
    spend(state, 'edit_file', 1);
    const msg = checkToolBudget(state as LoopState, 'edit_file')!;
    expect(msg).toContain(`edit_file has applied ${budget} edits this session (budget: ${budget})`);
    expect(msg).toContain(`The ${budget} edits that applied are kept.`);
  });

  it(`failed edits have their own cap of ${FAILED_EDIT_FACTOR}x the budget`, () => {
    const state = makeState();
    fail(state, budget * FAILED_EDIT_FACTOR - 1);
    expect(checkToolBudget(state as LoopState, 'edit_file')).toBeNull();
    fail(state, 1);
    const msg = checkToolBudget(state as LoopState, 'edit_file')!;
    expect(msg).toContain(`${budget * FAILED_EDIT_FACTOR} edit_file calls this session failed and changed nothing`);
    // The old refusal claimed edits were "applied and kept" when none had landed.
    expect(msg).toContain('None of your edits applied, so the file is unchanged.');
  });

  it('names one applied edit in the singular', () => {
    const state = makeState();
    spend(state, 'edit_file', 1);
    fail(state, budget * FAILED_EDIT_FACTOR);
    expect(checkToolBudget(state as LoopState, 'edit_file')).toContain('The 1 edit that applied is kept.');
  });

  it('offers ask_user only when someone can answer', () => {
    const state = makeState();
    spend(state, 'edit_file', budget);
    expect(checkToolBudget(state as LoopState, 'edit_file')).not.toContain('ask_user');
    expect(checkToolBudget(state as LoopState, 'edit_file', { canAskUser: true })).toContain('ask_user');
  });

  it('a failed call to any other tool still spends its budget', () => {
    const state = makeState();
    recordToolUse(state as LoopState, 'write_file', { failed: true });
    expect(state.toolCallCounts.get('write_file')).toBe(1);
    expect((state as LoopState).failedEditCalls).toBeUndefined();
  });

  it('records the refusal as a tool_budget decision with both counts', () => {
    const decisions: AgentDecision[] = [];
    const state = {
      ...makeState(),
      logger: { logDecision: (d: AgentDecision) => decisions.push(d) } as unknown as LoopState['logger'],
    };
    spend(state, 'edit_file', 2);
    fail(state, budget * FAILED_EDIT_FACTOR);
    checkToolBudget(state as LoopState, 'edit_file');
    expect(decisions).toEqual([
      { kind: 'tool_budget', action: 'refused', tool: 'edit_file', count: 2 + budget * FAILED_EDIT_FACTOR, budget },
    ]);
  });
});
