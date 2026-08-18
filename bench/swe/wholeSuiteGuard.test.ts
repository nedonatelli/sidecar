import { describe, it, expect } from 'vitest';
import { isWholeSuiteInvocation, wholeSuiteGuard } from './wholeSuiteGuard.js';

const DJANGO_CMD = './tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1';

describe('isWholeSuiteInvocation', () => {
  it('flags the bare spec command with no test label', () => {
    expect(isWholeSuiteInvocation(DJANGO_CMD)).toBe(true);
  });

  it('accepts a scoped invocation with a dotted test label', () => {
    expect(isWholeSuiteInvocation(`${DJANGO_CMD} utils_tests.test_autoreload`)).toBe(false);
  });

  it('accepts a scoped invocation with a path label', () => {
    expect(isWholeSuiteInvocation('./tests/runtests.py --settings=test_sqlite tests/utils_tests')).toBe(false);
  });

  it('treats numeric flag values as flags, not labels', () => {
    // `2` and `1` belong to --verbosity / --parallel; neither scopes the run.
    expect(isWholeSuiteInvocation('./tests/runtests.py --verbosity 2 --parallel 1')).toBe(true);
  });

  it('ignores commands that are not a test runner', () => {
    expect(isWholeSuiteInvocation('git status')).toBe(false);
    expect(isWholeSuiteInvocation('python manage.py shell')).toBe(false);
  });

  it('handles pytest-style runners', () => {
    expect(isWholeSuiteInvocation('python -m pytest')).toBe(true);
    expect(isWholeSuiteInvocation('python -m pytest tests/test_foo.py')).toBe(false);
  });

  it('is not fooled by leading/trailing whitespace', () => {
    expect(isWholeSuiteInvocation(`  ${DJANGO_CMD}  `)).toBe(true);
  });
});

const runCommandUse = (command: string) => ({
  type: 'tool_use' as const,
  id: 't1',
  name: 'run_command',
  input: { command },
});

const makeState = () => ({ messages: [] as Array<{ role: string; content: string }> });

describe('wholeSuiteGuard', () => {
  it('injects a corrective reprompt after a bare whole-suite run', async () => {
    const hook = wholeSuiteGuard();
    const state = makeState();
    const r = await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [runCommandUse(DJANGO_CMD)],
      } as never,
    );
    expect(r).toMatchObject({ mutated: true });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toContain('entire test suite');
  });

  it('does not fire on a scoped invocation', async () => {
    const hook = wholeSuiteGuard();
    const state = makeState();
    const r = await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [runCommandUse(`${DJANGO_CMD} utils_tests.test_autoreload`)],
      } as never,
    );
    expect(r).toBeUndefined();
    expect(state.messages).toHaveLength(0);
  });

  it('fires at most once per run so it cannot loop', async () => {
    const hook = wholeSuiteGuard();
    const state = makeState();
    const ctx = { pendingToolUses: [runCommandUse(DJANGO_CMD)] } as never;
    await hook.afterToolResults!(state as never, ctx);
    const second = await hook.afterToolResults!(state as never, ctx);
    expect(second).toBeUndefined();
    expect(state.messages).toHaveLength(1);
  });

  it('no-ops when the turn issued no tool calls', async () => {
    const hook = wholeSuiteGuard();
    const state = makeState();
    expect(await hook.afterToolResults!(state as never, {} as never)).toBeUndefined();
  });

  it('ignores non-shell tools', async () => {
    const hook = wholeSuiteGuard();
    const state = makeState();
    const r = await hook.afterToolResults!(
      state as never,
      {
        pendingToolUses: [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'x.py' } }],
      } as never,
    );
    expect(r).toBeUndefined();
  });
});
