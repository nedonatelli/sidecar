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
