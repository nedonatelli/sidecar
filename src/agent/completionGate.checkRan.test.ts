import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import { createGateState, recordToolCall, checkCompletionGate, buildGateInjection } from './completionGate.js';
import { checkDidNotRun, collectionErrorLine, isCollectionError } from './completionGate/checkRan.js';
import type { AgentDecision } from './decisions.js';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test' } }] as { uri: { fsPath: string } }[],
    fs: {
      stat: vi.fn(),
      readFile: vi.fn().mockRejectedValue(new Error('not found')),
    },
  },
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p })),
    joinPath: vi.fn((base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath, ...segments].join('/'),
    })),
  },
}));

import * as vscode from 'vscode';
const mockWorkspace = vscode.workspace as unknown as { fs: { stat: ReturnType<typeof vi.fn> } };

// #471, #473: results from commands that ran no check used to earn test or
// lint credit, and a pytest collection crash armed the red-check gate.

const runTests = (input: Record<string, unknown> = {}): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 'id',
  name: 'run_tests',
  input,
});
const runCommand = (command: string, extra: Record<string, unknown> = {}): ToolUseContentBlock => ({
  type: 'tool_use',
  id: 'id',
  name: 'run_command',
  input: { command, ...extra },
});
const result = (content: string): ToolResultContentBlock => ({ type: 'tool_result', tool_use_id: 'id', content });

/** pytest's output when a conftest can't import (matplotlib-18869 in the #464 canary). */
const CONFTEST_CRASH = [
  "ImportError while loading conftest '/repo/lib/matplotlib/tests/conftest.py'.",
  'lib/matplotlib/__init__.py:107: in <module>',
  '    from . import _api, _version, cbook, _docstring, rcsetup',
  'lib/matplotlib/cbook/__init__.py:30: in <module>',
  '    from matplotlib import _api, _c_internal_utils',
  "E   ImportError: cannot import name '_c_internal_utils' from partially initialized module 'matplotlib'",
  '(exit code: 4)',
].join('\n');

/** A test module that fails to import: collection stops, exit 2. */
const MODULE_CRASH = [
  '==================================== ERRORS ====================================',
  '____________ ERROR collecting sklearn/tests/test_base.py ____________',
  "E   ModuleNotFoundError: No module named 'distutils'",
  '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
  '(exit code: 2)',
].join('\n');

const UNITTEST_CRASH = [
  'E',
  '======================================================================',
  'ERROR: test_http (unittest.loader._FailedTest.test_http)',
  'ImportError: Failed to import test module: test_http',
  "ModuleNotFoundError: No module named 'hypothesis'",
  'Ran 1 test in 0.000s',
  'FAILED (errors=1)',
  '(exit code: 1)',
].join('\n');

describe('checkDidNotRun', () => {
  it('names each result that ran no check', () => {
    expect(checkDidNotRun('Background command started with ID: bg-1\nUse run_command with command_id="bg-1"')).toBe(
      'background',
    );
    expect(
      checkDidNotRun(
        'Command rejected: "pytest" is not in the allowed list for this context. Only read-only commands (grep, cat, find, ls, etc.) are permitted.',
      ),
    ).toBe('rejected');
    expect(checkDidNotRun('Could not detect test runner: no test files or config exist in this workspace.')).toBe(
      'no-runner',
    );
    expect(
      checkDidNotRun('ESLint only lints JavaScript/TypeScript — it cannot check Python files. For static checks…'),
    ).toBe('redirected');
    expect(checkDidNotRun('collecting ...\n\n⚠️ Command timed out after 120s with no output')).toBe('timed-out');
    expect(checkDidNotRun(CONFTEST_CRASH)).toBe('collection-error');
    expect(checkDidNotRun(MODULE_CRASH)).toBe('collection-error');
    expect(checkDidNotRun(UNITTEST_CRASH)).toBe('collection-error');
  });

  it('leaves runs that ran alone, failing ones included', () => {
    expect(checkDidNotRun('5 passed in 0.3s\n(exit code: 0)')).toBeNull();
    expect(
      checkDidNotRun('FAILED tests/test_x.py::test_a - AssertionError\n1 failed, 4 passed\n(exit code: 1)'),
    ).toBeNull();
    // A user interrupt also exits 2; without collection wording it isn't a crash.
    expect(isCollectionError('!!! KeyboardInterrupt !!!\n(exit code: 2)')).toBe(false);
    // Collection wording with a run that finished is a test that failed, not a crash.
    expect(isCollectionError('ERROR collecting tests/test_a.py\n(exit code: 1)')).toBe(false);
  });

  it('quotes the line that names the cause', () => {
    expect(collectionErrorLine(CONFTEST_CRASH)).toBe(
      "ImportError: cannot import name '_c_internal_utils' from partially initialized module 'matplotlib'",
    );
    expect(collectionErrorLine(MODULE_CRASH)).toBe("ModuleNotFoundError: No module named 'distutils'");
    expect(collectionErrorLine(UNITTEST_CRASH)).toBe('ImportError: Failed to import test module: test_http');
  });

  it('skips the advice an import error prints after itself (scikit-learn-10297)', () => {
    const out = [
      '_____________ ERROR collecting sklearn/tests/test_base.py _____________',
      "E   ImportError: No module named 'sklearn.__check_build._check_build'",
      'E   It seems that scikit-learn has not been built correctly.',
      'E   If you have used an installer, please check that it is suited for your',
      'E   Python version, your operating system and your platform.',
      '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
      '(exit code: 2)',
    ].join('\n');
    expect(collectionErrorLine(out)).toBe("ImportError: No module named 'sklearn.__check_build._check_build'");
  });
});

describe('recordToolCall: a collection crash (#471)', () => {
  it('run_tests: no test credit and no red-check', () => {
    const state = createGateState();
    recordToolCall(state, runTests(), result(CONFTEST_CRASH));
    expect(state.testsRanSinceLastEdit).toBe(false);
    expect(state.projectTestsRan).toBe(false);
    expect(state.failedCheckOutput).toBeUndefined();
    expect(state.testCollectionError).toContain('_c_internal_utils');
  });

  it('run_command pytest: no credit for the file, no red-check even with Python red-check on', () => {
    const state = createGateState();
    state.pythonRedCheck = true;
    recordToolCall(state, runCommand('python -m pytest sklearn/tests/test_base.py'), result(MODULE_CRASH));
    expect(state.testsRanSinceLastEdit).toBe(false);
    expect(state.testsRunForFiles.size).toBe(0);
    expect(state.failedCheckOutput).toBeUndefined();
    expect(state.testCollectionError).toBe("ModuleNotFoundError: No module named 'distutils'");
  });

  it('a later run that ran clears the note and earns credit', () => {
    const state = createGateState();
    recordToolCall(state, runTests(), result(CONFTEST_CRASH));
    recordToolCall(state, runTests(), result('3 passed in 0.1s\n(exit code: 0)'));
    expect(state.testCollectionError).toBeUndefined();
    expect(state.testsRanSinceLastEdit).toBe(true);
    expect(state.projectTestsPassed).toBe(true);
  });

  it('records that the run was recognized but ran nothing', () => {
    const decisions: AgentDecision[] = [];
    recordToolCall(createGateState(), runCommand('pytest tests/test_a.py'), result(MODULE_CRASH), undefined, {
      logDecision: (d) => void decisions.push(d),
    });
    expect(decisions).toContainEqual(
      expect.objectContaining({ kind: 'verification_run', recognized: true, didNotRun: 'collection-error' }),
    );
  });
});

describe('recordToolCall: results where nothing ran (#473)', () => {
  it('a test runner started in the background, refused, or timed out earns no credit', () => {
    for (const [tu, text] of [
      [runCommand('pytest tests/', { background: true }), 'Background command started with ID: bg-1'],
      [
        runCommand('pytest tests/'),
        'Command rejected: "pytest tests/" is not in the allowed list for this context. Only read-only commands are permitted.',
      ],
      [
        runCommand('./tests/runtests.py utils_tests'),
        'Testing against Django...\n\n⚠️ Command timed out after 120s with no output',
      ],
      [runCommand('npm test', { background: true }), 'Background command started with ID: bg-2'],
    ] as const) {
      const state = createGateState();
      recordToolCall(state, tu, result(text));
      expect(state.testsRanSinceLastEdit, text).toBe(false);
      expect(state.projectTestsRan, text).toBe(false);
    }
  });

  it('"Could not detect test runner" waives the test demand but is not a test run', () => {
    const state = createGateState();
    recordToolCall(
      state,
      runTests(),
      result('Could not detect test runner: no test files or config exist in this workspace.'),
    );
    expect(state.noTestRunner).toBe(true);
    expect(state.projectTestsRan).toBe(false);
    expect(state.testsRanSinceLastEdit).toBe(false);
  });

  it('a redirected, backgrounded or refused lint run is not a lint run', () => {
    for (const [tu, text] of [
      [
        runCommand('npx eslint calc.py'),
        'ESLint only lints JavaScript/TypeScript — it cannot check Python files. For static checks on edited code, call `get_diagnostics`.',
      ],
      [runCommand('npx tsc --noEmit', { background: true }), 'Background command started with ID: bg-3'],
      [runCommand('ruff check .'), 'Command rejected: "ruff check ." is not in the allowed list for this context.'],
    ] as const) {
      const state = createGateState();
      recordToolCall(state, tu, result(text));
      expect(state.lintObserved, text).toBe(false);
      expect(state.checkerUnavailable, text).toBeUndefined();
    }
  });

  it('a lint run that ran still counts', () => {
    const state = createGateState();
    recordToolCall(state, runCommand('npx tsc --noEmit'), result('(exit code: 0)'));
    expect(state.lintObserved).toBe(true);
  });

  it('a backgrounded repro script does not clear a red check', () => {
    const state = createGateState();
    state.pythonRedCheck = true;
    state.failedCheckOutput = 'Traceback (most recent call last): ...';
    recordToolCall(
      state,
      runCommand('python repro.py', { background: true }),
      result('Background command started with ID: bg-4'),
    );
    expect(state.failedCheckOutput).toBe('Traceback (most recent call last): ...');
  });
});

describe('checkCompletionGate: the new state', () => {
  const statOnly = (...ok: string[]) =>
    mockWorkspace.fs.stat.mockImplementation((uri: { fsPath: string }) =>
      ok.some((suffix) => uri.fsPath.replace(/\\/g, '/').endsWith(suffix))
        ? Promise.resolve({})
        : Promise.reject(new Error('not found')),
    );
  beforeEach(() => vi.clearAllMocks());

  it('a collection crash leaves the test demand and names the error in it', async () => {
    statOnly('/tests');
    const state = createGateState();
    state.editedFiles.add('lib/matplotlib/colors.py');
    state.syntaxCleanFiles = new Set(['lib/matplotlib/colors.py']);
    recordToolCall(state, runTests(), result(CONFTEST_CRASH));
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([
      {
        file: 'lib/matplotlib/colors.py',
        needsTestRun: true,
        testCollectionError:
          "ImportError: cannot import name '_c_internal_utils' from partially initialized module 'matplotlib'",
      },
    ]);
    const text = buildGateInjection(findings, 1, 2);
    expect(text).toContain('Your last test run ran no tests');
    expect(text).toContain('_c_internal_utils');
    expect(text).toContain('do not edit code to fix it');
  });

  it('a test path the runner could not find is named as the target, not the environment', async () => {
    statOnly('/tests');
    const state = createGateState();
    state.editedFiles.add('seaborn/_core/scales.py');
    state.syntaxCleanFiles = new Set(['seaborn/_core/scales.py']);
    recordToolCall(
      state,
      runCommand('python -m pytest utils_tests.test_autoreload'),
      result('ERROR: file or directory not found: utils_tests.test_autoreload\n\ncollected 0 items\n(exit code: 4)'),
    );
    const text = buildGateInjection(await checkCompletionGate(state), 1, 2);
    expect(text).toContain('could not find the test target you gave it');
    expect(text).toContain('ERROR: file or directory not found: utils_tests.test_autoreload');
    expect(text).not.toContain('comes from the environment');
  });

  it('no test runner: no test demand', async () => {
    statOnly('/tests');
    const state = createGateState();
    state.editedFiles.add('pkg/mod.py');
    state.syntaxCleanFiles = new Set(['pkg/mod.py']);
    state.noTestRunner = true;
    expect(await checkCompletionGate(state)).toEqual([]);
  });
});
