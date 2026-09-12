import { describe, it, expect } from 'vitest';
import { reproFirstGuard, isFailingResult, isTestPath } from './reproFirstGuard.js';

const use = (name: string, input: Record<string, unknown>, id = 't1') => ({
  type: 'tool_use' as const,
  id,
  name,
  input,
});
const result = (id: string, content: string) => ({ type: 'tool_result' as const, tool_use_id: id, content });
const makeState = () => ({ messages: [] as Array<{ role: string; content: string }> });

function harness(tracked: string[] = ['django/db/models/query.py', 'tests/queries/tests.py']) {
  const reverted: string[] = [];
  const said: string[] = [];
  const hook = reproFirstGuard({
    isTracked: (p) => tracked.includes(p),
    revert: (p) => reverted.push(p),
    onText: (t) => said.push(t),
    maxReverts: 2,
  });
  return { hook, reverted, said };
}

describe('isFailingResult', () => {
  it('reads run_command failure from the appended exit code', () => {
    expect(isFailingResult('run_command', 'Traceback ...\nAssertionError\n(exit code: 1)')).toBe(true);
    expect(isFailingResult('run_command', 'all good')).toBe(false); // no status line = exit 0
  });
  it('does not count a hung command as a demonstration', () => {
    expect(isFailingResult('run_command', 'starting...\n\n⚠️ Command timed out after 120s with no output')).toBe(false);
  });
  it('classifies run_tests output like the completion gate', () => {
    expect(isFailingResult('run_tests', 'FAILED tests/test_x.py::test_y - AssertionError\n1 failed in 0.2s')).toBe(
      true,
    );
    expect(isFailingResult('run_tests', '3 passed in 0.1s')).toBe(false);
    expect(isFailingResult('run_tests', 'no tests ran')).toBe(false); // ran nothing: proves nothing
  });
});

describe('isTestPath', () => {
  it('recognises test modules, test files and conftest', () => {
    for (const p of [
      'tests/queries/tests.py',
      'lib/pkg/test_foo.py',
      'pkg/foo_test.py',
      'conftest.py',
      'a\\tests\\b.py',
    ])
      expect(isTestPath(p), p).toBe(true);
    expect(isTestPath('django/db/models/query.py')).toBe(false);
  });
});

describe('reproFirstGuard', () => {
  it('reverts a source edit made before any failure was demonstrated, and says so', async () => {
    const { hook, reverted, said } = harness();
    const state = makeState();
    const r = await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [use('edit_file', { path: 'django/db/models/query.py' })],
        toolResults: [result('t1', '<tool_output>edited')],
      } as never,
    );
    expect(r).toMatchObject({ mutated: true });
    expect(reverted).toEqual(['django/db/models/query.py']);
    expect(state.messages[0].content).toMatch(/Reverted your edit/);
    expect(said.some((t) => t.startsWith('🛡️'))).toBe(true); // recorded in the trajectory
    expect(hook.stats().reverts).toBe(1);
  });

  it('lets reproduction material through: new files and test files', async () => {
    const { hook, reverted } = harness();
    const state = makeState();
    const r = await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [
          use('write_file', { path: 'repro.py' }, 'a'),
          use('edit_file', { path: 'tests/queries/tests.py' }, 'b'),
        ],
        toolResults: [result('a', '<tool_output>written'), result('b', '<tool_output>edited')],
      } as never,
    );
    expect(r).toMatchObject({ mutated: false });
    expect(reverted).toEqual([]);
  });

  it('allows source edits once a command has failed, and remembers which command', async () => {
    const { hook, reverted } = harness();
    const state = makeState();
    await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [use('run_command', { command: 'python repro.py' })],
        toolResults: [result('t1', 'AssertionError\n(exit code: 1)')],
      } as never,
    );
    expect(hook.stats()).toMatchObject({ demonstrated: true, reproCommand: 'python repro.py' });
    const r = await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [use('edit_file', { path: 'django/db/models/query.py' })],
        toolResults: [result('t1', '<tool_output>edited')],
      } as never,
    );
    expect(r).toMatchObject({ mutated: false });
    expect(reverted).toEqual([]);
    expect(hook.stats().sourceEdits).toBe(1);
  });

  it('does not treat a green run or a failed edit as a demonstration', async () => {
    const { hook } = harness();
    const state = makeState();
    await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [
          use('run_command', { command: 'python -m pytest tests/x' }, 'a'),
          use('edit_file', { path: 'django/db/models/query.py' }, 'b'),
        ],
        toolResults: [result('a', '5 passed in 0.3s'), result('b', 'Error: search text not found')],
      } as never,
    );
    expect(hook.stats().demonstrated).toBe(false);
    expect(hook.stats().reverts).toBe(0); // the edit did not land, nothing to revert
  });

  it('stops enforcing at the revert cap so it cannot become its own cycle', async () => {
    const { hook, reverted } = harness();
    const state = makeState();
    for (let i = 0; i < 4; i++) {
      await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [use('edit_file', { path: 'django/db/models/query.py' })],
          toolResults: [result('t1', '<tool_output>edited')],
        } as never,
      );
    }
    expect(reverted).toHaveLength(2); // maxReverts
    expect(hook.stats()).toMatchObject({ gaveUp: true, reverts: 2, sourceEdits: 2 });
  });

  it('asks once for a re-run when the model finishes without re-running its repro after editing', async () => {
    const { hook } = harness();
    const state = makeState();
    await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [use('run_command', { command: 'python repro.py' })],
        toolResults: [result('t1', '(exit code: 1)')],
      } as never,
    );
    await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [use('edit_file', { path: 'django/db/models/query.py' })],
        toolResults: [result('t1', '<tool_output>edited')],
      } as never,
    );
    const r1 = await hook.onEmptyResponse!(state as never, {} as never);
    expect(r1).toMatchObject({ mutated: true });
    expect(state.messages.at(-1)!.content).toContain('python repro.py');
    const r2 = await hook.onEmptyResponse!(state as never, {} as never);
    expect(r2).toBeUndefined(); // once
  });

  it('is satisfied when the repro was re-run after the last edit', async () => {
    const { hook } = harness();
    const state = makeState();
    const step = (uses: unknown[], results: unknown[]) =>
      hook.afterToolResults!(state as never, { pendingToolUses: uses, toolResults: results } as never);
    await step([use('run_command', { command: 'python repro.py' })], [result('t1', '(exit code: 1)')]);
    await step([use('edit_file', { path: 'django/db/models/query.py' })], [result('t1', '<tool_output>edited')]);
    await step([use('run_command', { command: 'python repro.py' })], [result('t1', 'ok')]);
    expect(await hook.onEmptyResponse!(state as never, {} as never)).toBeUndefined();
    expect(state.messages).toHaveLength(0);
  });
});
