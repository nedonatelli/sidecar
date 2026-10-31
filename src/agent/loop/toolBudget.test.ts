import { describe, it, expect } from 'vitest';
import {
  checkToolBudget,
  recordToolUse,
  toolBudgetFor,
  baseToolBudget,
  FAILED_EDIT_FACTOR,
  isToolBudgetSpent,
  toolBudgetRefusals,
  isShellSearch,
  budgetKey,
} from './toolBudget.js';
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
    // (On a fresh run: a second refusal in the same run is worded differently, #268.)
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

// #268: 78% of runs that hit a budget called the refused tool again. The second
// and later refusals say so, and name only tools the model can still call.
describe('a repeat refusal escalates (#268)', () => {
  const offering =
    (...names: string[]) =>
    (n: string) =>
      names.includes(n);
  const spentRunCommand = () => {
    const state = makeState() as LoopState;
    spend(state, 'run_command', 15);
    return state;
  };
  const pytest = { command: 'python -m pytest -rA testing/test_junitxml.py' };

  it('the second refusal differs from the first, and later ones keep counting', () => {
    const state = spentRunCommand();
    const opts = { isOffered: offering('run_command'), input: pytest };
    const first = checkToolBudget(state, 'run_command', opts)!;
    const second = checkToolBudget(state, 'run_command', opts)!;
    const third = checkToolBudget(state, 'run_command', opts)!;
    expect(first).not.toContain('refusal');
    expect(second).not.toBe(first);
    expect(second).toContain('This is refusal 2 of run_command since its budget ran out: the call did not run');
    expect(second).toContain('every further run_command call this session will be refused the same way');
    expect(third).toContain('This is refusal 3 of run_command');
    expect(toolBudgetRefusals(state, 'run_command')).toBe(3);
  });

  it("counts refusals per tool: another tool's first refusal is still the plain one", () => {
    const state = spentRunCommand();
    spend(state, 'grep', 15);
    checkToolBudget(state, 'run_command');
    checkToolBudget(state, 'run_command');
    expect(checkToolBudget(state, 'grep')).not.toContain('refusal');
    expect(toolBudgetRefusals(state, 'grep')).toBe(1);
  });

  it('an allowed call and isToolBudgetSpent count no refusal', () => {
    const state = makeState() as LoopState;
    spend(state, 'run_command', 14);
    expect(checkToolBudget(state, 'run_command')).toBeNull();
    spend(state, 'run_command', 1);
    expect(isToolBudgetSpent(state, 'run_command')).toBe(true);
    expect(toolBudgetRefusals(state, 'run_command')).toBe(0);
  });

  it('points a test command sent through run_command at run_tests when it is offered', () => {
    const state = spentRunCommand();
    const opts = { isOffered: offering('run_command', 'run_tests', 'read_file'), input: pytest };
    checkToolBudget(state, 'run_command', opts);
    const msg = checkToolBudget(state, 'run_command', opts)!;
    expect(msg).toContain('Instead: run the tests with run_tests, which has its own budget.');
    // A test command is not pointed at file-reading tools.
    expect(msg).not.toContain('read_file');
  });

  it('does not name run_tests when it is hidden (the SWE harness) or spent; it says to finish', () => {
    for (const hidden of [true, false]) {
      const state = spentRunCommand();
      if (!hidden) spend(state, 'run_tests', 10);
      const opts = { isOffered: offering('run_command', ...(hidden ? [] : ['run_tests'])), input: pytest };
      checkToolBudget(state, 'run_command', opts);
      const msg = checkToolBudget(state, 'run_command', opts)!;
      expect(msg).not.toContain('run_tests');
      expect(msg).toContain('Stop calling run_command and give your final answer from what you have already gathered.');
    }
  });

  it('points another shell command at the offered file tools', () => {
    const state = spentRunCommand();
    const opts = { isOffered: offering('read_file', 'grep'), input: { command: 'cat src/a.py' } };
    checkToolBudget(state, 'run_command', opts);
    const msg = checkToolBudget(state, 'run_command', opts)!;
    expect(msg).toContain('Instead: to look at files, use read_file or grep rather than a shell command.');
    expect(msg).toContain('If none of those does what you need, stop calling tools and give your final answer');
    expect(msg).not.toContain('list_directory');
  });

  it('names no alternative when the caller does not say what is offered', () => {
    const state = spentRunCommand();
    checkToolBudget(state, 'run_command', { input: { command: 'cat a.py' } });
    const msg = checkToolBudget(state, 'run_command', { input: { command: 'cat a.py' } })!;
    expect(msg).not.toContain('Instead');
    expect(msg).toContain('Stop calling run_command');
  });

  it('after edit_file it offers write_file, and says which files write_file will not overwrite', () => {
    const budget = baseToolBudget('edit_file');
    const state = { ...makeState(), filesEditedViaEditTool: new Set(['src/a.py']) } as LoopState;
    spend(state, 'edit_file', budget);
    const opts = { isOffered: offering('edit_file', 'write_file') };
    checkToolBudget(state, 'edit_file', opts);
    const msg = checkToolBudget(state, 'edit_file', opts)!;
    expect(msg).toContain(`edit_file has applied ${budget} edits this session`);
    expect(msg).toContain('This is refusal 2 of edit_file');
    expect(msg).toContain('write the whole file with write_file, giving its complete new content, not a fragment');
    expect(msg).toContain('write_file refuses to overwrite a file you already changed with edit_file: `src/a.py`');
    // Never a smaller edit_file: every edit_file call is refused.
    expect(msg).not.toMatch(/smaller|another edit_file/);
  });

  it('after failed edits it still says the file is unchanged, and omits write_file once that is spent', () => {
    const budget = baseToolBudget('edit_file');
    const state = makeState() as LoopState;
    for (let i = 0; i < budget * FAILED_EDIT_FACTOR; i++) recordToolUse(state, 'edit_file', { failed: true });
    spend(state, 'write_file', baseToolBudget('write_file'));
    const opts = { isOffered: offering('edit_file', 'write_file') };
    checkToolBudget(state, 'edit_file', opts);
    const msg = checkToolBudget(state, 'edit_file', opts)!;
    expect(msg).toContain('None of your edits applied, so the file is unchanged.');
    expect(msg).not.toContain('write_file');
    expect(msg).toContain('Stop calling edit_file and give your final answer');
  });

  it('after a search tool it offers read_file on a path already found', () => {
    for (const tool of ['grep', 'search_files', 'list_directory']) {
      const state = makeState() as LoopState;
      spend(state, tool, baseToolBudget(tool));
      const opts = { isOffered: offering('read_file', 'search_files') };
      checkToolBudget(state, tool, opts);
      const msg = checkToolBudget(state, tool, opts)!;
      expect(msg).toContain('open a file your earlier results already named with read_file');
      expect(msg.includes('find files by name with search_files')).toBe(tool === 'list_directory');
    }
  });

  it('after read_file it offers grep', () => {
    const state = makeState() as LoopState;
    spend(state, 'read_file', baseToolBudget('read_file'));
    const opts = { isOffered: offering('grep') };
    checkToolBudget(state, 'read_file', opts);
    expect(checkToolBudget(state, 'read_file', opts)).toContain('find the lines you need with grep');
  });

  it('offers ask_user on a repeat only when someone can answer', () => {
    const state = spentRunCommand();
    checkToolBudget(state, 'run_command');
    expect(checkToolBudget(state, 'run_command', { canAskUser: true })).toContain(
      'explain why to the user via ask_user',
    );
    expect(checkToolBudget(state, 'run_command')).not.toContain('ask_user');
  });

  it('records every refusal as a decision, first or repeat', () => {
    const decisions: AgentDecision[] = [];
    const state = {
      ...makeState(),
      logger: { logDecision: (d: AgentDecision) => decisions.push(d) } as unknown as LoopState['logger'],
    } as LoopState;
    spend(state, 'grep', 15);
    checkToolBudget(state, 'grep');
    checkToolBudget(state, 'grep');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toEqual({ kind: 'tool_budget', action: 'refused', tool: 'grep', count: 15, budget: 15 });
  });
});

// #311: gemma4:31b searched through run_command, so on the SWE canary 21% of its
// runs spent run_command's budget, about half on searches, and 16% ended with
// the last source edit untested. Commands below are from those runs.
describe('a shell search spends the search budget (#311)', () => {
  it('counts plain searches and file prints, alone or piped', () => {
    for (const cmd of [
      'grep -rn "_sympify" sympy/core/expr.py sympy/core/sympify.py',
      'grep -r "_version" lib/matplotlib | head -n 20',
      'find sympy -name "*test*"',
      'cat bin/test',
      'ls -F lib/matplotlib/',
      'cd sympy && grep -n "def refine" assumptions/refine.py',
      'sed -n 100,140p src/_pytest/pathlib.py',
      'grep -n x a.py 2>/dev/null',
      'rg -n "foo" src 2>&1 | wc -l',
      'grep -o "fields.E[0-9]*" django/db/models/fields/related.py | sort -V | tail -n 5',
    ]) {
      expect(isShellSearch(cmd), cmd).toBe(true);
    }
  });

  it('does not count tests, scripts, installs, or anything that writes a file', () => {
    for (const cmd of [
      './tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 queries',
      'pytest -rA test_skipping',
      'python3 reproduce_issue.py',
      'pip list',
      'cat <<EOF > reproduce_issue.py\nfrom sympy import Poly\nEOF',
      'cat a.py > b.py',
      'grep -l foo src | tee hits.txt',
      'find . -name "*.pyc" -delete',
      'find . -name x -exec rm {} \;',
      'sed -i "s/a/b/" f.py',
      'mkdir -p tests/roots/x',
      'cd sympy',
      'grep -n x a.py && python3 a.py',
      '',
    ]) {
      expect(isShellSearch(cmd), cmd).toBe(false);
    }
  });

  it('budgetKey sends a search run_command to grep and leaves every other call alone', () => {
    expect(budgetKey('run_command', { command: 'grep -n x a.py' })).toBe('grep');
    expect(budgetKey('run_command', { command: 'pytest -rA t.py' })).toBe('run_command');
    expect(budgetKey('run_command', {})).toBe('run_command');
    expect(budgetKey('grep', { command: 'pytest' })).toBe('grep');
    expect(budgetKey('read_file', { path: 'a.py' })).toBe('read_file');
  });
});
