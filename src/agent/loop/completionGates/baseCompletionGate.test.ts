import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../completionGate.js', () => ({
  checkCompletionGate: vi.fn(async () => []),
  buildGateInjection: vi.fn(() => 'Verify your edited files before finishing.'),
  describeFindingKinds: vi.fn(() => []),
}));

import { baseCompletionGate as gate, actionableFindings, canRunCommands } from './baseCompletionGate.js';
import { checkCompletionGate } from '../../completionGate.js';
import type { GateContext } from './types.js';
import type { LoopState } from '../state.js';
import type { getConfig } from '../../../config/settings.js';

const ctx = (completionGateEnabled = true): GateContext => ({
  config: { completionGateEnabled } as ReturnType<typeof getConfig>,
  options: {} as GateContext['options'],
  signal: new AbortController().signal,
  callbacks: { onText: vi.fn() } as unknown as GateContext['callbacks'],
});

const makeState = (edited = new Set(['a.ts']), gateInjections = 0) =>
  ({
    gateState: { editedFiles: edited, gateInjections },
    messages: [],
    logger: undefined,
    scaffoldingProfile: undefined,
  }) as unknown as LoopState;

beforeEach(() => vi.mocked(checkCompletionGate).mockReset().mockResolvedValue([]));

describe('baseCompletionGate', () => {
  it('is gated by the completion-gate master', () => {
    expect(gate.enabled({ completionGateEnabled: true } as ReturnType<typeof getConfig>)).toBe(true);
    expect(gate.enabled({ completionGateEnabled: false } as ReturnType<typeof getConfig>)).toBe(false);
  });

  it('skips when nothing was edited', async () => {
    expect(await gate.maybeInject(makeState(new Set()), ctx())).toBe('skip');
    expect(checkCompletionGate).not.toHaveBeenCalled();
  });

  it('skips when the check finds no unverified edits', async () => {
    expect(await gate.maybeInject(makeState(), ctx())).toBe('skip');
  });

  it('injects and increments the counter when there are unverified findings', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([{ file: 'a.ts' } as never]);
    const s = makeState();
    expect(await gate.maybeInject(s, ctx())).toBe('injected');
    expect(s.gateState.gateInjections).toBe(1);
    expect(JSON.stringify(s.messages[0])).toContain('Verify your edited files');
  });

  it('stands down (skip) once the injection cap is exhausted', async () => {
    const s = makeState(new Set(['a.ts']), 999);
    expect(await gate.maybeInject(s, ctx())).toBe('skip');
    expect(checkCompletionGate).not.toHaveBeenCalled();
  });
});

// #505: the gate asked for project tests after an edit to repro.py, and after
// run_command had stopped accepting calls. Neither demand can be met.
describe('baseCompletionGate: demands the model cannot or need not meet (#505)', () => {
  const withTools = (
    tools: string[],
    counts: Record<string, number> = {},
    budgets: Record<string, number> = {},
    edited = new Set(['django/db/models/query.py']),
  ) =>
    ({
      gateState: { editedFiles: edited, gateInjections: 0 },
      messages: [],
      logger: undefined,
      tools: tools.map((name) => ({ name, description: '', input_schema: { type: 'object', properties: {} } })),
      toolCallCounts: new Map(Object.entries(counts)),
      scaffoldingProfile: { toolBudgets: budgets },
      approvalMode: 'autonomous',
    }) as unknown as LoopState;

  it('waives every finding on a scratch script, and does not fire', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([
      { file: 'repro.py', needsTestRun: true },
      { file: 'reproduce_issue.py', needsLint: true },
    ]);
    const s = withTools(['run_command'], {}, {}, new Set(['repro.py', 'reproduce_issue.py']));
    expect(await gate.maybeInject(s, ctx())).toBe('skip');
    expect(s.gateState.gateInjections).toBe(0);
    expect(s.messages).toHaveLength(0);
  });

  it('still fires for the source file when scratch files were edited too', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([
      { file: 'repro.py', needsTestRun: true },
      { file: 'django/db/models/query.py', needsTestRun: true },
    ]);
    const s = withTools(['run_command']);
    expect(await gate.maybeInject(s, ctx())).toBe('injected');
    expect(s.gateState.gateInjections).toBe(1);
  });

  it('waives a test demand once run_command is spent and run_tests is not offered', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([{ file: 'django/db/models/query.py', needsTestRun: true }]);
    const s = withTools(['run_command', 'read_file'], { run_command: 60 }, { run_command: 60 });
    expect(await gate.maybeInject(s, ctx())).toBe('skip');
    expect(s.gateState.gateInjections).toBe(0);
  });

  it('keeps the test demand while run_tests can still run', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([{ file: 'django/db/models/query.py', needsTestRun: true }]);
    const s = withTools(['run_command', 'run_tests'], { run_command: 60 }, { run_command: 60, run_tests: 20 });
    expect(await gate.maybeInject(s, ctx())).toBe('injected');
  });

  it('keeps a lint demand when no command can run: get_diagnostics needs no shell', async () => {
    vi.mocked(checkCompletionGate).mockResolvedValueOnce([
      { file: 'src/a.ts', missingTest: 'src/a.test.ts' },
      { file: 'src/a.ts', needsLint: true },
    ]);
    const s = withTools(['get_diagnostics']);
    expect(await gate.maybeInject(s, ctx())).toBe('injected');
  });
});

describe('actionableFindings', () => {
  it('drops scratch files always, and test-run findings only when no command can run', () => {
    const findings = [
      { file: 'repro.py', needsTestRun: true },
      { file: 'pkg/mod.py', needsTestRun: true },
      { file: 'src/a.ts', missingTest: 'src/a.test.ts' },
      { file: 'src/a.ts', needsLint: true },
      { file: 'src/a.ts', testNotUpdated: 'src/a.test.ts' },
    ];
    expect(actionableFindings(findings, true).map((f) => f.file)).toEqual([
      'pkg/mod.py',
      'src/a.ts',
      'src/a.ts',
      'src/a.ts',
    ]);
    expect(actionableFindings(findings, false)).toEqual([
      { file: 'src/a.ts', needsLint: true },
      { file: 'src/a.ts', testNotUpdated: 'src/a.test.ts' },
    ]);
  });
});

describe('canRunCommands', () => {
  const state = (tools: string[], counts: Record<string, number>, budgets: Record<string, number>, plan = false) =>
    ({
      tools: tools.map((name) => ({ name })),
      toolCallCounts: new Map(Object.entries(counts)),
      scaffoldingProfile: { toolBudgets: budgets },
      approvalMode: plan ? 'plan' : 'autonomous',
    }) as unknown as LoopState;

  it('is true while an offered command tool has budget left', () => {
    expect(canRunCommands(state(['run_command'], { run_command: 59 }, { run_command: 60 }))).toBe(true);
  });

  it('is false when every offered command tool is spent, or none is offered', () => {
    expect(canRunCommands(state(['run_command'], { run_command: 60 }, { run_command: 60 }))).toBe(false);
    expect(canRunCommands(state(['read_file'], {}, {}))).toBe(false);
  });

  it('counts extra tools the caller passed', () => {
    const withExtra = { options: { extraTools: [{ definition: { name: 'run_tests' } }] } } as unknown as GateContext;
    expect(canRunCommands(state(['read_file'], {}, { run_tests: 20 }), withExtra)).toBe(true);
  });

  it('is false in plan mode, where the catalog is ask_user only', () => {
    expect(canRunCommands(state(['run_command', 'ask_user'], {}, { run_command: 60 }, true))).toBe(false);
  });
});
