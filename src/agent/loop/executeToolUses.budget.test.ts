import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stubLoopState } from './testHelpers.js';
import type { LoopState } from './state.js';
import type { ToolDefinition } from '../tools/shared.js';
import type { ToolOutcome } from '../tools/toolOutcome.js';

// executeToolUses against the REAL tool budget (#425). executeToolUses.test.ts
// mocks toolBudget.js to test routing; these tests are about how a batch, an
// alias and a no-op spend the budget, so only the executor is mocked.

vi.mock('../executor.js', () => ({
  executeTool: vi.fn(),
  resolveToolPermission: vi.fn(async () => ({ explicitPermission: undefined, denied: null })),
}));

import { executeToolUses } from './executeToolUses.js';
import { executeTool } from '../executor.js';
import { toolBudgetFor } from './toolBudget.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

const catalog = (names: string[]): ToolDefinition[] =>
  names.map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} } }));

function state(): LoopState {
  return stubLoopState({ tools: catalog(['edit_file', 'run_command', 'read_file', 'grep']) });
}

function callbacks(): AgentCallbacks {
  return { onText: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn(), onDone: vi.fn() } as unknown as AgentCallbacks;
}

let seq = 0;
function use(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${++seq}`, name, input };
}

/** executeTool reports `outcome` for every call, after a tick, and returns `content`. */
function executorReports(outcome: ToolOutcome | undefined, content = 'File edited: a.py') {
  vi.mocked(executeTool).mockImplementation(async (tu, opts) => {
    await new Promise((r) => setTimeout(r, 1));
    if (outcome) opts?.toolOutcomes?.set(tu.id, outcome);
    return { type: 'tool_result', tool_use_id: tu.id, content };
  });
}

const run = (s: LoopState, uses: ToolUseContentBlock[]) =>
  executeToolUses(s, uses, {} as SideCarClient, {} as AgentOptions, callbacks(), new AbortController().signal);

beforeEach(() => {
  vi.mocked(executeTool).mockReset();
});

describe('a parallel batch spends the budget call by call (#425)', () => {
  it('one slot left runs one call of a batch, and refuses the rest', async () => {
    const s = state();
    const budget = toolBudgetFor(s, 'edit_file');
    s.toolCallCounts.set('edit_file', budget - 1);
    executorReports({ kind: 'mutated', paths: ['a.py'] });

    const results = await run(s, [use('edit_file'), use('edit_file'), use('edit_file')]);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.is_error === true)).toEqual([false, true, true]);
    expect(String(results[1].content)).toContain('1 more from this turn is still running');
    expect(s.toolCallCounts.get('edit_file')).toBe(budget);
    expect(s.toolCallsInFlight?.size ?? 0).toBe(0);
  });

  it('a batch of refused calls counts as one refusal, so the refused-repeat stop still takes three turns', async () => {
    const s = state();
    s.toolCallCounts.set('read_file', toolBudgetFor(s, 'read_file'));
    await run(s, [use('read_file'), use('read_file'), use('read_file')]);
    expect(s.toolBudgetRefusals?.get('read_file')).toBe(1);
    await run(s, [use('read_file')]);
    expect(s.toolBudgetRefusals?.get('read_file')).toBe(2);
  });
});

describe('an aliased call spends the tool it runs as (#425)', () => {
  it('bash draws on run_command, and str_replace on edit_file', async () => {
    const s = state();
    s.toolCallCounts.set('run_command', toolBudgetFor(s, 'run_command'));
    const [refused] = await run(s, [use('bash', { command: 'pytest tests/test_a.py' })]);
    expect(refused.is_error).toBe(true);
    expect(String(refused.content)).toMatch(/^Tool "run_command" has been called/);
    expect(executeTool).not.toHaveBeenCalled();

    executorReports({ kind: 'mutated', paths: ['a.py'] });
    await run(s, [use('str_replace', { path: 'a.py', search: 'a', replace: 'b' })]);
    expect(s.toolCallCounts.get('edit_file')).toBe(1);
    expect(s.toolCallCounts.has('str_replace')).toBe(false);
  });
});

describe('a no-op edit does not spend the edit budget (#425)', () => {
  it('"No change needed" counts with the edits that changed nothing', async () => {
    const s = state();
    executorReports({ kind: 'noop', paths: ['a.py'] }, 'No change needed: the edit is already applied.');
    const [result] = await run(s, [use('edit_file', { path: 'a.py' })]);
    expect(result.is_error).toBeFalsy();
    expect(s.toolCallCounts.get('edit_file') ?? 0).toBe(0);
    expect(s.failedEditCalls).toBe(1);

    executorReports({ kind: 'mutated', paths: ['a.py'] });
    await run(s, [use('edit_file', { path: 'a.py' })]);
    expect(s.toolCallCounts.get('edit_file')).toBe(1);
  });
});
