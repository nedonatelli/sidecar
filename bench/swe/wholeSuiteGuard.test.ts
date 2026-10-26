import { describe, it, expect } from 'vitest';
import { isWholeSuiteInvocation, isUnscopedRunTests, wholeSuiteGuard } from './wholeSuiteGuard.js';

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

  // #260: the 24 orphaned sympy full-suite runs of 2026-10-24.
  it("flags sympy's bare bin/test and accepts it scoped", () => {
    expect(isWholeSuiteInvocation('python bin/test -C --verbose')).toBe(true);
    expect(isWholeSuiteInvocation('./bin/test')).toBe(true);
    expect(isWholeSuiteInvocation('bin/test -C')).toBe(true);
    expect(isWholeSuiteInvocation('python bin/test sympy/core/tests/test_basic.py')).toBe(false);
    // A flag's value reads as a label (the existing rule): `-k name` is scoped enough.
    expect(isWholeSuiteInvocation('python bin/test -k test_issue_15346')).toBe(false);
  });
});

describe('isUnscopedRunTests (#260)', () => {
  it('is true for run_tests with neither command nor file', () => {
    expect(isUnscopedRunTests({})).toBe(true);
    expect(isUnscopedRunTests(undefined)).toBe(true);
    expect(isUnscopedRunTests({ command: '  ' })).toBe(true);
    expect(isUnscopedRunTests({ file: 'sympy/core/tests/test_basic.py' })).toBe(false);
    expect(isUnscopedRunTests({ command: 'python bin/test sympy/core' })).toBe(false);
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

  // #260: `run_tests {}` started sympy's whole suite in sympy-15346 and sympy-21055.
  it('treats run_tests with no command and no file as a whole-suite run', async () => {
    const use = (input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: 't', name: 'run_tests', input });
    const unscoped = makeState();
    const r = await wholeSuiteGuard().afterToolResults!(unscoped as never, { pendingToolUses: [use({})] } as never);
    expect(r).toMatchObject({ mutated: true, reason: 'whole-suite test invocation' });
    const scoped = makeState();
    const s = await wholeSuiteGuard().afterToolResults!(
      scoped as never,
      { pendingToolUses: [use({ file: 'sympy/core/tests/test_basic.py' })] } as never,
    );
    expect(s).toBeUndefined();
    expect(scoped.messages).toHaveLength(0);
  });

  // Scoping the run is only half of it: an invalid label is just as broken a
  // verification channel as no label. Observed 2026-08-18 — the agent scoped to
  // `tests/file_uploads/` (a path), django derived `file_uploads.tests`, and it
  // failed to import. It then retried the identical command four times.
  describe('invalid test label', () => {
    const IMPORT_FAIL =
      'file_uploads.tests (unittest.loader._FailedTest) ... ERROR\n' +
      'ERROR: file_uploads.tests (unittest.loader._FailedTest)\n' +
      "ImportError: Failed to import test module: file_uploads.tests\nModuleNotFoundError: No module named 'file_uploads.tests'";

    it('reprompts when a scoped run fails to import the label', async () => {
      const hook = wholeSuiteGuard();
      const state = makeState();
      const r = await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [runCommandUse(`${DJANGO_CMD} tests/file_uploads/`)],
          toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: IMPORT_FAIL }],
        } as never,
      );
      expect(r).toMatchObject({ mutated: true });
      expect(state.messages[0].content).toContain('test label');
    });

    it('does not fire when the scoped run actually executed tests', async () => {
      const hook = wholeSuiteGuard();
      const state = makeState();
      const r = await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [runCommandUse(`${DJANGO_CMD} file_uploads`)],
          toolResults: [
            { type: 'tool_result', tool_use_id: 't1', content: 'Ran 42 tests in 3.2s\n\nFAILED (failures=1)' },
          ],
        } as never,
      );
      expect(r).toBeUndefined();
      expect(state.messages).toHaveLength(0);
    });

    // django answers a source-module label with `Ran 0 tests ... OK` — not an
    // error, and it reads like success. Seven of these went unnoticed in one run.
    it('catches a label that resolved but ran nothing', async () => {
      const hook = wholeSuiteGuard();
      const state = makeState();
      const r = await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [runCommandUse(`${DJANGO_CMD} django.core.files.uploadedfile`)],
          toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: 'Ran 0 tests in 0.000s\n\nOK' }],
        } as never,
      );
      expect(r).toMatchObject({ mutated: true });
    });

    it('does not treat an ordinary test failure as a bad label', async () => {
      const hook = wholeSuiteGuard();
      const state = makeState();
      const r = await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [runCommandUse(`${DJANGO_CMD} file_uploads`)],
          toolResults: [
            { type: 'tool_result', tool_use_id: 't1', content: 'AssertionError: 493 != 420\nFAILED (failures=1)' },
          ],
        } as never,
      );
      expect(r).toBeUndefined();
    });

    it('fires at most once, independently of the bare-suite reprompt', async () => {
      const hook = wholeSuiteGuard();
      const state = makeState();
      const ctx = {
        pendingToolUses: [runCommandUse(`${DJANGO_CMD} tests/file_uploads/`)],
        toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: IMPORT_FAIL }],
      } as never;
      await hook.afterToolResults!(state as never, ctx);
      expect(await hook.afterToolResults!(state as never, ctx)).toBeUndefined();
      expect(state.messages).toHaveLength(1);
    });

    it('can fire for a bad label after already firing for a bare suite', async () => {
      const hook = wholeSuiteGuard();
      const state = makeState();
      await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [runCommandUse(DJANGO_CMD)],
        } as never,
      );
      const r = await hook.afterToolResults!(
        state as never,
        {
          pendingToolUses: [runCommandUse(`${DJANGO_CMD} tests/file_uploads/`)],
          toolResults: [{ type: 'tool_result', tool_use_id: 't1', content: IMPORT_FAIL }],
        } as never,
      );
      expect(r).toMatchObject({ mutated: true });
      expect(state.messages).toHaveLength(2);
    });
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
