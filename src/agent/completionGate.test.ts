/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import {
  createGateState,
  recordToolCall,
  checkCompletionGate,
  buildGateInjection,
  buildNoReadReprompt,
  buildNoShellReprompt,
  buildNoFileWriteReprompt,
  buildNoGroundingReprompt,
  buildUnverifiedClaimReprompt,
  buildBehavioralVerificationReprompt,
  classifyTestResult,
  findColocatedTest,
  lastUserText,
} from './completionGate.js';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test' } }] as { uri: { fsPath: string } }[],
    fs: {
      stat: vi.fn(),
    },
  },
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p })),
  },
}));

import * as vscode from 'vscode';
const mockWorkspace = vscode.workspace as any;

function makeEdit(file: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 'id', name: 'write_file', input: { path: file, content: 'x' } };
}
function makeRunTests(file?: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 'id', name: 'run_tests', input: file ? { file } : {} };
}
function makeRunCommand(command: string): ToolUseContentBlock {
  return { type: 'tool_use', id: 'id', name: 'run_command', input: { command } };
}
function ok(): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: 'id', content: 'ok' };
}
function err(): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: 'id', content: 'boom', is_error: true };
}

describe('completionGate — recordToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test' } }];
  });

  it('records a successful edit as an edited file', () => {
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    expect([...state.editedFiles]).toEqual(['src/foo.ts']);
  });

  it('ignores edits whose tool result was an error', () => {
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), err());
    expect(state.editedFiles.size).toBe(0);
  });

  it('accepts both `path` and `file_path` input fields for edits', () => {
    const state = createGateState();
    recordToolCall(state, { type: 'tool_use', id: 'id', name: 'edit_file', input: { file_path: 'src/bar.ts' } }, ok());
    expect([...state.editedFiles]).toEqual(['src/bar.ts']);
  });

  it('normalizes absolute paths to workspace-relative', () => {
    const state = createGateState();
    recordToolCall(state, makeEdit('/test/src/foo.ts'), ok());
    expect([...state.editedFiles]).toEqual(['src/foo.ts']);
  });

  it('drops paths outside the workspace', () => {
    const state = createGateState();
    recordToolCall(state, makeEdit('/etc/passwd'), ok());
    expect(state.editedFiles.size).toBe(0);
  });

  it('records run_tests with a specific file', () => {
    const state = createGateState();
    recordToolCall(state, makeRunTests('src/foo.test.ts'), ok());
    expect([...state.testsRunForFiles]).toEqual(['src/foo.test.ts']);
    expect(state.projectTestsRan).toBe(false);
  });

  it('records run_tests without a file as whole-suite', () => {
    const state = createGateState();
    recordToolCall(state, makeRunTests(), ok());
    expect(state.projectTestsRan).toBe(true);
  });

  it('detects eslint in run_command as lintObserved', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx eslint src/'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('detects tsc in run_command as lintObserved', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx tsc --noEmit'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('get_diagnostics call satisfies lint requirement', () => {
    // The primary post-edit tool is get_diagnostics (Rule 6 + tool description
    // both say "mandatory after every edit"). Without this, a model following
    // instructions would be reprompted to run eslint even though it already
    // called get_diagnostics.
    const state = createGateState();
    const diag: ToolUseContentBlock = { type: 'tool_use', id: 'id', name: 'get_diagnostics', input: {} };
    recordToolCall(state, diag, ok());
    expect(state.lintObserved).toBe(true);
  });

  it('get_diagnostics error does NOT satisfy lint requirement', () => {
    const state = createGateState();
    const diag: ToolUseContentBlock = { type: 'tool_use', id: 'id', name: 'get_diagnostics', input: {} };
    recordToolCall(state, diag, err());
    expect(state.lintObserved).toBe(false);
  });

  it('npm run lint satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npm run lint'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('npm run compile satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npm run compile'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('pnpm run check satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('pnpm run check'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('pylint satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('pylint src/'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('flake8 satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('flake8 src/main.py'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('mypy satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('mypy --strict src/'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('ruff satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('ruff check .'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('go vet satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('go vet ./...'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('golangci-lint satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('golangci-lint run'), ok());
    expect(state.lintObserved).toBe(true);
  });

  it('staticcheck satisfies lint requirement', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('staticcheck ./...'), ok());
    expect(state.lintObserved).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // extractTestFiles coverage — each pattern in the regex needs a positive
  // test AND a negative test so regressions (e.g. \S+ → .* that starts
  // matching filenames with spaces) are caught immediately.
  // ---------------------------------------------------------------------------

  it('detects pytest with a suffix-style Python test file', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('python -m pytest tests/auth_test.py'), ok());
    expect([...state.testsRunForFiles]).toEqual(['tests/auth_test.py']);
  });

  it('detects pytest with a prefix-style Python test file', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('pytest test_utils.py'), ok());
    expect([...state.testsRunForFiles]).toEqual(['test_utils.py']);
  });

  it('does NOT record a space-containing path as a specific test file (\\S+ regression guard)', () => {
    // Guards against the \S+ → .* regression in extractTestFiles.
    // With `.*`: extractTestFiles returns ["tests/my test.py"] — a bogus path —
    //   so testsRunForFiles gets a wrong entry and projectTestsRan stays false.
    // With correct `\S+`: extractTestFiles returns [] — no match for the
    //   space-in-name path — so the gate falls back to whole-suite (projectTestsRan=true).
    const state = createGateState();
    recordToolCall(state, makeRunCommand('pytest "tests/my test.py"'), ok());
    // No bogus space-containing path should be recorded as a specific file.
    expect([...state.testsRunForFiles]).toHaveLength(0);
    // pytest was detected but no specific file matched → whole-suite assumption.
    expect(state.projectTestsRan).toBe(true);
  });

  it('detects a Go test file (normalizePath strips the ./ prefix)', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('go test ./internal/auth_test.go'), ok());
    // normalizePath resolves ./internal/auth_test.go relative to workspace root
    // and returns the workspace-relative form without the ./ prefix.
    expect([...state.testsRunForFiles]).toEqual(['internal/auth_test.go']);
  });

  it('detects vitest with a file argument as per-file test run', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx vitest run src/foo.test.ts'), ok());
    expect([...state.testsRunForFiles]).toEqual(['src/foo.test.ts']);
    expect(state.projectTestsRan).toBe(false);
  });

  it('detects vitest without a file as whole-suite', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx vitest run'), ok());
    expect(state.projectTestsRan).toBe(true);
  });

  it('detects `npm test` as whole-suite', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npm test'), ok());
    expect(state.projectTestsRan).toBe(true);
  });

  it('does not mark lint observed when eslint is a substring of another word', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('echo "no-eslint-here"'), ok());
    // `\beslint\b` boundary should still match "no-eslint-here" because `-`
    // is a word boundary. That's fine — the point is we detect the string.
    // This test documents current behavior; if it flakes, we'd need a
    // stricter matcher. Keeping it explicit so changes are intentional.
    expect(state.lintObserved).toBe(true);
  });

  it('ignores errored verification runs', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx eslint .'), err());
    expect(state.lintObserved).toBe(false);
  });
});

describe('completionGate — findColocatedTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test' } }];
  });

  it('returns the .test.ts path when one exists next to the source', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const result = await findColocatedTest('src/foo.ts');
    expect(result).toBe('src/foo.test.ts');
  });

  it('falls back to .spec.ts if .test.ts is missing', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.spec.ts') return { type: 1 };
      throw new Error('not found');
    });
    const result = await findColocatedTest('src/foo.ts');
    expect(result).toBe('src/foo.spec.ts');
  });

  it('returns null when no colocated test exists', async () => {
    (mockWorkspace.fs.stat as any).mockRejectedValue(new Error('not found'));
    const result = await findColocatedTest('src/foo.ts');
    expect(result).toBeNull();
  });
});

describe('completionGate — checkCompletionGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test' } }];
  });

  it('returns no findings when no edits happened', async () => {
    const state = createGateState();
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('flags an edited source file with no lint run as needsLint', async () => {
    (mockWorkspace.fs.stat as any).mockRejectedValue(new Error('not found'));
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([{ file: 'src/foo.ts', needsLint: true }]);
  });

  it('flags missing test run when a colocated test exists', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint src/foo.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([{ file: 'src/foo.ts', missingTest: 'src/foo.test.ts' }]);
  });

  it('passes when lint ran and the colocated test ran (and test file was also edited)', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeEdit('src/foo.test.ts'), ok()); // test file was also updated
    recordToolCall(state, makeRunCommand('npx eslint src/foo.ts'), ok());
    recordToolCall(state, makeRunTests('src/foo.test.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('flags testNotUpdated when tests ran but test file was not edited', async () => {
    // The 'add new linter patterns' scenario: model edits implementation,
    // runs existing tests (they pass), but never updates the test file.
    // Gate should prompt: "add coverage for the new functionality."
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint src/foo.ts'), ok());
    recordToolCall(state, makeRunTests('src/foo.test.ts'), ok()); // ran but didn't edit
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([{ file: 'src/foo.ts', testNotUpdated: 'src/foo.test.ts' }]);
  });

  it('does NOT flag testNotUpdated when the test file was also edited', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeEdit('src/foo.test.ts'), ok()); // updated!
    recordToolCall(state, makeRunCommand('npx eslint src/foo.ts'), ok());
    recordToolCall(state, makeRunTests('src/foo.test.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('does NOT flag testNotUpdated when tests were not run (missingTest fires instead)', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint src/foo.ts'), ok());
    // No run_tests call — missingTest fires, not testNotUpdated
    const findings = await checkCompletionGate(state);
    expect(findings.some((f) => f.missingTest)).toBe(true);
    expect(findings.some((f) => f.testNotUpdated)).toBe(false);
  });

  it('passes when projectTestsRan covers all edited files', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint .'), ok());
    recordToolCall(state, makeRunCommand('npm test'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('does not require a test for a file that has no colocated test', async () => {
    (mockWorkspace.fs.stat as any).mockRejectedValue(new Error('not found'));
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint .'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('skips non-source files', async () => {
    const state = createGateState();
    recordToolCall(state, makeEdit('README.md'), ok());
    recordToolCall(state, makeEdit('config.json'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('skips .d.ts declaration files', async () => {
    const state = createGateState();
    recordToolCall(state, makeEdit('types/foo.d.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });

  it('does not require a test for an edited test file itself', async () => {
    (mockWorkspace.fs.stat as any).mockRejectedValue(new Error('not found'));
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.test.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint src/foo.test.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
  });
});

describe('completionGate — buildGateInjection', () => {
  it('includes a static-check section leading with get_diagnostics when needsLint findings exist', () => {
    const text = buildGateInjection([{ file: 'src/foo.ts', needsLint: true }], 1, 2);
    expect(text).toContain('static check');
    expect(text).toContain('get_diagnostics');
    // src/foo.ts is JS/TS, so the eslint suggestion still appears.
    expect(text).toContain('npx eslint src/foo.ts');
  });

  it('does NOT suggest eslint for Python files — only get_diagnostics (the dogfood fix)', () => {
    const text = buildGateInjection([{ file: 'calculator.py', needsLint: true }], 1, 2);
    expect(text).toContain('get_diagnostics');
    expect(text).not.toContain('eslint');
  });

  it('includes a test command section when missingTest findings exist', () => {
    const text = buildGateInjection([{ file: 'src/foo.ts', missingTest: 'src/foo.test.ts' }], 1, 2);
    expect(text).toContain('Tests for the files you edited have not run');
    expect(text).toContain('run_tests with file: src/foo.test.ts');
    expect(text).toContain('npx vitest run src/foo.test.ts');
  });

  it('deduplicates lint files across findings', () => {
    const text = buildGateInjection(
      [
        { file: 'src/foo.ts', needsLint: true },
        { file: 'src/foo.ts', missingTest: 'src/foo.test.ts' },
      ],
      1,
      2,
    );
    const lintOccurrences = text.split('src/foo.ts').length - 1;
    // Expect the source path to appear: once in the lint list, once in the
    // test mapping line. Anything more means deduplication failed.
    expect(lintOccurrences).toBeLessThanOrEqual(3);
  });

  it('adds a final-attempt warning only when attempt >= max', () => {
    const mid = buildGateInjection([{ file: 'src/foo.ts', needsLint: true }], 1, 2);
    const last = buildGateInjection([{ file: 'src/foo.ts', needsLint: true }], 2, 2);
    expect(mid).not.toContain('final gate attempt');
    expect(last).toContain('final gate attempt');
  });

  it('contains the anti-summary directive', () => {
    const text = buildGateInjection([{ file: 'src/foo.ts', needsLint: true }], 1, 2);
    expect(text).toContain('Summary of Changes');
    expect(text).toContain('do not claim anything passes');
  });
});

describe('completionGate — buildNoReadReprompt', () => {
  const tool = (name: string, input: Record<string, unknown> = {}) => ({
    type: 'tool_use' as const,
    id: 'x',
    name,
    input,
  });
  const userMsg = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
  const assistantToolMsg = (name: string, input: Record<string, unknown> = {}) => ({
    role: 'assistant' as const,
    content: [tool(name, input)],
  });

  it('fires when user mentions a file and no read tool was called', () => {
    const msgs = [userMsg('Read src/greeter.ts and tell me what it does.')];
    const result = buildNoReadReprompt(msgs);
    expect(result).not.toBeNull();
    expect(result).toContain('greeter.ts');
    expect(result).toContain('read_file');
  });

  it('returns null when read_file was called with the mentioned file path', () => {
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      assistantToolMsg('read_file', { path: 'src/greeter.ts' }),
    ];
    expect(buildNoReadReprompt(msgs)).toBeNull();
  });

  it('returns null when run_command references the mentioned file', () => {
    const msgs = [
      userMsg('What TypeScript version is in package.json?'),
      assistantToolMsg('run_command', { command: "jq '.devDependencies.typescript' package.json" }),
    ];
    expect(buildNoReadReprompt(msgs)).toBeNull();
  });

  it('fires when run_command was called but for a different file than mentioned', () => {
    // model ran wc -l for src/ but user asked about package.json — gap 1 fix
    const msgs = [
      userMsg('What TypeScript version is in package.json?'),
      assistantToolMsg('run_command', { command: 'wc -l src/**/*.ts' }),
    ];
    const result = buildNoReadReprompt(msgs);
    expect(result).not.toBeNull();
    expect(result).toContain('package.json');
  });

  it('returns null when user message mentions no file extension', () => {
    const msgs = [userMsg('What is the capital of France?')];
    expect(buildNoReadReprompt(msgs)).toBeNull();
  });

  it('returns null when there are no messages', () => {
    expect(buildNoReadReprompt([])).toBeNull();
  });

  it('uses requestText (current turn) over the first message when provided — multi-turn anchoring', () => {
    // Continuing chat: first message is the original build task; current turn is
    // a title tweak. The no-read gate must judge the CURRENT request, not the
    // stale original — otherwise it fires on calculator.py from turn 1.
    const msgs = [
      userMsg('Build calculator.py and test_calculator.py.'),
      assistantToolMsg('read_file', { path: 'gui_calculator.py' }),
      userMsg('change the window title in gui_calculator.py'),
    ];
    // Anchored on the original message → would fire for calculator.py.
    expect(buildNoReadReprompt(msgs, new Set())).not.toBeNull();
    // Anchored on the current request → gui_calculator.py was read → no fire.
    expect(buildNoReadReprompt(msgs, new Set(), 'change the window title in gui_calculator.py')).toBeNull();
  });

  it('no-file-write gate respects requestText (does not fire on stale original-prompt files)', async () => {
    const msgs = [userMsg('Create calculator.py and write test_calculator.py.')];
    const noFile = async () => false; // treat named files as not-yet-created
    // Stale anchor: fires for the original files not written this run.
    expect(await buildNoFileWriteReprompt(msgs, new Set(['gui_calculator.py']), undefined, noFile)).not.toBeNull();
    // Current-turn anchor mentions only gui_calculator.py, which IS edited → no fire.
    expect(
      await buildNoFileWriteReprompt(
        msgs,
        new Set(['gui_calculator.py']),
        'write changes to gui_calculator.py to add a button',
        noFile,
      ),
    ).toBeNull();
  });

  it('returns null when the agent authored the mentioned file (write implies knowing contents)', () => {
    // "build calculator.py" — the user names the file with write intent; the
    // agent creates + tests it but never reads it. A read is redundant.
    const msgs = [userMsg('Build a small Python calculator. Create calculator.py with four functions.')];
    expect(buildNoReadReprompt(msgs, new Set(['calculator.py']))).toBeNull();
  });

  it('matches an authored file by basename when editedFiles holds a longer path', () => {
    const msgs = [userMsg('Create calculator.py with the four functions.')];
    expect(buildNoReadReprompt(msgs, new Set(['src/calculator.py']))).toBeNull();
  });

  it('still fires for a mentioned file the agent did NOT author', () => {
    const msgs = [userMsg('Read src/greeter.ts and tell me what it does.')];
    expect(buildNoReadReprompt(msgs, new Set(['calculator.py']))).not.toBeNull();
  });
});

describe('completionGate — lastUserText', () => {
  it('returns the most recent user message, not the first', () => {
    const msgs = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'original task' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] },
      { role: 'user' as const, content: 'current turn request' },
    ];
    expect(lastUserText(msgs)).toBe('current turn request');
  });

  it('returns empty string when there are no user messages', () => {
    expect(lastUserText([{ role: 'assistant' as const, content: 'hi' }])).toBe('');
  });
});

describe('completionGate — buildNoShellReprompt', () => {
  const userMsg = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
  const runCommandMsg = (command: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool_use' as const, id: 'x', name: 'run_command', input: { command } }],
  });

  it('fires when user asks a file count without running a shell command', () => {
    const msgs = [userMsg('How many test files are in src/?')];
    const result = buildNoShellReprompt(msgs);
    expect(result).not.toBeNull();
    expect(result).toContain('shell command');
  });

  it('fires when user asks for the largest source file without a shell command', () => {
    const msgs = [userMsg('What is the largest source file in src/ by line count?')];
    expect(buildNoShellReprompt(msgs)).not.toBeNull();
  });

  it('fires when user asks for a version without a shell command', () => {
    const msgs = [userMsg('What is the version of TypeScript in package.json?')];
    expect(buildNoShellReprompt(msgs)).not.toBeNull();
  });

  it('returns null when run_command was already called', () => {
    const msgs = [userMsg('How many test files are in src/?'), runCommandMsg('find src -name "*.test.ts" | wc -l')];
    expect(buildNoShellReprompt(msgs)).toBeNull();
  });

  it('returns null for a general question with no workspace directory reference', () => {
    const msgs = [userMsg('How many planets are in the solar system?')];
    expect(buildNoShellReprompt(msgs)).toBeNull();
  });

  it('returns null for a non-metric question mentioning src/', () => {
    const msgs = [userMsg('Explain how the agent loop in src/ works.')];
    expect(buildNoShellReprompt(msgs)).toBeNull();
  });
});

describe('completionGate — buildNoGroundingReprompt', () => {
  const userMsg = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
  const assistantToolMsg = (name: string, input: Record<string, unknown> = {}) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool_use' as const, id: 'x', name, input }],
  });

  it('fires when user asks to review the architecture and no tool was called', () => {
    const msgs = [userMsg('Review the design and architecture of this project.')];
    const result = buildNoGroundingReprompt(msgs);
    expect(result).not.toBeNull();
    expect(result).toContain('without reading any of it');
  });

  it('fires for "evaluate this codebase"', () => {
    expect(buildNoGroundingReprompt([userMsg('Evaluate this codebase for me.')])).not.toBeNull();
  });

  it('fires for "audit the structure of the repo"', () => {
    expect(buildNoGroundingReprompt([userMsg('Audit the structure of the repository.')])).not.toBeNull();
  });

  it('returns null once a grounding tool (read_file) was called', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantToolMsg('read_file', { path: 'src/agent/loop.ts' }),
    ];
    expect(buildNoGroundingReprompt(msgs)).toBeNull();
  });

  it('returns null once project_knowledge_search was called', () => {
    const msgs = [
      userMsg('Assess the design of this codebase.'),
      assistantToolMsg('project_knowledge_search', { query: 'auth' }),
    ];
    expect(buildNoGroundingReprompt(msgs)).toBeNull();
  });

  it('returns null for an analysis verb with no workspace target', () => {
    expect(buildNoGroundingReprompt([userMsg('Review my résumé wording.')])).toBeNull();
  });

  it('returns null for a workspace target with no analysis verb', () => {
    expect(buildNoGroundingReprompt([userMsg('Explain the architecture of this project.')])).toBeNull();
  });

  it('returns null when there are no messages', () => {
    expect(buildNoGroundingReprompt([])).toBeNull();
  });
});

describe('completionGate — buildUnverifiedClaimReprompt', () => {
  const userMsg = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
  const assistantMsg = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }] });
  // Fake workspace: only these paths "exist".
  const realFiles = new Set(['src/agent/context.ts', 'src/agent/loop.ts', 'src/agent/loop/messageBuild.ts']);
  const fileExists = async (p: string) => realFiles.has(p);

  it('fires when the review cites a path that does not exist', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('Context management lives in `src/context/context.ts` and is solid.'),
    ];
    const result = await buildUnverifiedClaimReprompt(msgs, fileExists);
    expect(result).not.toBeNull();
    expect(result).toContain('src/context/context.ts');
  });

  it('does not flag a real path', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('The loop in `src/agent/loop.ts` is well structured.'),
    ];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists)).toBeNull();
  });

  it('treats a .js citation as resolved when the .ts sibling exists (NodeNext)', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('Message construction is in `src/agent/loop/messageBuild.js`.'),
    ];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists)).toBeNull();
  });

  it('fires on a hedge phrase even when all paths resolve', async () => {
    const msgs = [
      userMsg('Audit the design of this codebase.'),
      assistantMsg('The loop (`src/agent/loop.ts`) is coupled to context, though I cannot verify the call site.'),
    ];
    const result = await buildUnverifiedClaimReprompt(msgs, fileExists);
    expect(result).not.toBeNull();
    expect(result).toContain('unverified claim');
  });

  it('does not fire on a non-analysis request (avoids flagging proposed new files)', async () => {
    const msgs = [
      userMsg('Create a new helper at src/utils/clamp.ts.'),
      assistantMsg('I will add `src/utils/clamp.ts` with the clamp function.'),
    ];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists)).toBeNull();
  });

  it('returns null when there is no assistant answer yet', async () => {
    const msgs = [userMsg('Review the architecture of this project.')];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists)).toBeNull();
  });
});

describe('completionGate — buildBehavioralVerificationReprompt', () => {
  const edited = new Set<string>(['gui_calculator.py']);
  const noTests = {
    testsRunForFiles: new Set<string>(),
    passingTestFiles: new Set<string>(),
    projectTestsPassed: false,
  };
  // A PASSING test file that exercises gui_calculator (imports the module).
  const guiTestRan = {
    testsRunForFiles: new Set<string>(['test_gui_calculator.py']),
    passingTestFiles: new Set<string>(['test_gui_calculator.py']),
    projectTestsPassed: false,
  };
  const readGuiTest = async (p: string) =>
    p === 'test_gui_calculator.py' ? 'from gui_calculator import CalculatorApp\n' : null;

  it('fires on a bug report when code was edited but no test ran', async () => {
    const r = await buildBehavioralVerificationReprompt('clicking the number buttons does nothing', edited, noTests);
    expect(r).not.toBeNull();
    expect(r).toContain('test');
  });

  it('matches varied bug-report phrasings', async () => {
    for (const req of [
      'the calculator is broken',
      "the display doesn't update when I click",
      'it stopped working after the change',
      'the equals button fails to compute',
      'nothing happens when I press a key',
    ]) {
      expect(await buildBehavioralVerificationReprompt(req, edited, noTests)).not.toBeNull();
    }
  });

  it('does NOT fire when a test that exercises the edited file ran', async () => {
    expect(
      await buildBehavioralVerificationReprompt('clicking does nothing', edited, guiTestRan, readGuiTest),
    ).toBeNull();
  });

  it('STILL fires when a test ran but it does not exercise the edited file (wrong-target)', async () => {
    // Editing gui_calculator.py but running test_calculator.py (imports calculator, not gui_calculator).
    const wrongTarget = {
      testsRunForFiles: new Set<string>(['test_calculator.py']),
      passingTestFiles: new Set<string>(['test_calculator.py']),
      projectTestsPassed: false,
    };
    const readCalcTest = async (p: string) =>
      p === 'test_calculator.py' ? 'from calculator import add, subtract\n' : null;
    const r = await buildBehavioralVerificationReprompt('clicking does nothing', edited, wrongTarget, readCalcTest);
    expect(r).not.toBeNull();
    expect(r).toContain('gui_calculator.py');
    expect(r).toContain('UNRELATED');
  });

  it('counts a whole-suite run when a conventional test file imports the module', async () => {
    const suite = {
      testsRunForFiles: new Set<string>(),
      passingTestFiles: new Set<string>(),
      projectTestsPassed: true,
    };
    expect(await buildBehavioralVerificationReprompt('clicking does nothing', edited, suite, readGuiTest)).toBeNull();
  });

  it('fires on a whole-suite run when no test for the edited module exists', async () => {
    const suite = {
      testsRunForFiles: new Set<string>(),
      passingTestFiles: new Set<string>(),
      projectTestsPassed: true,
    };
    const r = await buildBehavioralVerificationReprompt('clicking does nothing', edited, suite, async () => null);
    expect(r).not.toBeNull();
  });

  it('does NOT fire when no code was edited', async () => {
    expect(await buildBehavioralVerificationReprompt('clicking does nothing', new Set(), noTests)).toBeNull();
  });

  it('does NOT fire when only a test file was edited (no behavioral source)', async () => {
    const onlyTest = new Set<string>(['test_gui_calculator.py']);
    expect(await buildBehavioralVerificationReprompt('the gui is broken', onlyTest, noTests)).toBeNull();
  });

  it('fires on a behavior-implying BUILD (not just bug reports) with no test', async () => {
    for (const req of [
      'Build a Tkinter GUI for the calculator',
      'create a command-line calculator app',
      'add a clear button to the calculator',
      'implement a /health endpoint on the server',
      'write a CLI that parses the arguments',
    ]) {
      expect(await buildBehavioralVerificationReprompt(req, edited, noTests)).not.toBeNull();
    }
  });

  it('does NOT fire on a structural/non-behavioral build', async () => {
    for (const req of [
      'create a tsconfig.json with strict mode',
      'add a LICENSE file',
      'write a README describing the project',
      'add a TypeScript interface for the config',
    ]) {
      expect(await buildBehavioralVerificationReprompt(req, edited, noTests)).toBeNull();
    }
  });

  it('does NOT fire on a behavior-implying build once a test exercises the file', async () => {
    expect(
      await buildBehavioralVerificationReprompt(
        'Build a Tkinter GUI for the calculator',
        edited,
        guiTestRan,
        readGuiTest,
      ),
    ).toBeNull();
  });

  // --- Hollow-test detection (dogfood: model wrote test_gui_calculator.py that
  //     never imported gui_calculator and tested an inline mock instead). ---
  it('fires with the hollow-test message when the test never imports the module', async () => {
    // The model wrote AND ran test_gui_calculator.py, but it tests a mock.
    const editedWithTest = new Set<string>(['gui_calculator.py', 'test_gui_calculator.py']);
    const ran = {
      testsRunForFiles: new Set<string>(['test_gui_calculator.py']),
      passingTestFiles: new Set<string>(['test_gui_calculator.py']),
      projectTestsPassed: false,
    };
    const readHollow = async (p: string) =>
      p === 'test_gui_calculator.py' ? 'import pytest\nclass MockCalculatorApp: ...\n' : null;
    const r = await buildBehavioralVerificationReprompt('the gui is broken', editedWithTest, ran, readHollow);
    expect(r).not.toBeNull();
    expect(r).toContain('never imports the module under test');
    expect(r).toContain('test_gui_calculator.py');
    expect(r).toContain('from gui_calculator import');
  });

  it('does NOT flag a hollow test when the test genuinely imports the module', async () => {
    const editedWithTest = new Set<string>(['gui_calculator.py', 'test_gui_calculator.py']);
    const ran = {
      testsRunForFiles: new Set<string>(['test_gui_calculator.py']),
      passingTestFiles: new Set<string>(['test_gui_calculator.py']),
      projectTestsPassed: false,
    };
    const r = await buildBehavioralVerificationReprompt('the gui is broken', editedWithTest, ran, readGuiTest);
    expect(r).toBeNull();
  });

  // --- A test that RAN but didn't PASS must not satisfy the gate (dogfood:
  //     qwen3.5's run collected 0 tests yet "verified" a broken GUI). ---
  it('a comment-only mention of the module does NOT count as importing it (hollow stays hollow)', async () => {
    const editedWithTest = new Set<string>(['gui_calculator.py', 'test_gui_calculator.py']);
    const ran = {
      testsRunForFiles: new Set<string>(['test_gui_calculator.py']),
      passingTestFiles: new Set<string>(['test_gui_calculator.py']),
      projectTestsPassed: false,
    };
    // Mentions the module in a comment but never imports it — a mock test.
    const readMentionOnly = async (p: string) =>
      p === 'test_gui_calculator.py' ? '# exercises gui_calculator behavior\nclass MockApp: ...\n' : null;
    const r = await buildBehavioralVerificationReprompt('the gui is broken', editedWithTest, ran, readMentionOnly);
    expect(r).not.toBeNull();
    expect(r).toContain('never imports the module under test');
  });

  it('STILL fires when the test ran but collected 0 tests (not in passingTestFiles)', async () => {
    const ranButEmpty = {
      testsRunForFiles: new Set<string>(['test_gui_calculator.py']), // it ran…
      passingTestFiles: new Set<string>(), // …but passed nothing
      projectTestsPassed: false,
    };
    const r = await buildBehavioralVerificationReprompt(
      'the gui is broken',
      edited,
      ranButEmpty,
      readGuiTest,
      'Ran 0 tests — NO TESTS RAN',
    );
    expect(r).not.toBeNull();
    expect(r).toContain('PASSES');
    expect(r).toContain('NO TESTS RAN'); // failure context surfaced inline
  });
});

describe('completionGate — classifyTestResult', () => {
  it('classifies a passing pytest run', () => {
    expect(classifyTestResult('===== 5 passed in 0.05s =====\n(exit code: 0)')).toBe('pass');
  });
  it('classifies ANSI-colored pytest output as pass (run_tests emits color on a TTY)', () => {
    // The escape \x1b[1m ends in `m` right before the digit — without stripping,
    // the \b in \b\d+ passed\b fails and a real pass reads as "unknown".
    const colored =
      'test_calculator.py .....\n========= \x1b[32m\x1b[1m5 passed\x1b[0m\x1b[32m in 0.10s\x1b[0m =========';
    expect(classifyTestResult(colored)).toBe('pass');
  });
  it('classifies ANSI-colored failures correctly', () => {
    expect(classifyTestResult('\x1b[31m\x1b[1m1 failed\x1b[0m, 4 passed')).toBe('fail');
  });
  it('classifies a 0-collected run as empty (the dogfood case)', () => {
    expect(classifyTestResult('Ran 0 tests in 0.000s\n\nNO TESTS RAN\n(exit code: 5)')).toBe('empty');
    expect(classifyTestResult('collected 0 items')).toBe('empty');
  });
  it('classifies a failing run', () => {
    expect(classifyTestResult('1 failed, 2 passed\n(exit code: 1)')).toBe('fail');
    expect(classifyTestResult('Traceback (most recent call last):\n  NameError')).toBe('fail');
  });
  it('treats "0 failed" as a PASS, not a fail', () => {
    expect(classifyTestResult('===== 5 passed, 0 failed in 0.1s =====')).toBe('pass');
    expect(classifyTestResult('5 passed, 0 failed, 0 skipped\n(exit code: 0)')).toBe('pass');
  });
  it('classifies mocha "N passing" as pass', () => {
    expect(classifyTestResult('  5 passing (20ms)')).toBe('pass');
  });
  it('classifies go-test FAIL and pytest collection errors as fail', () => {
    expect(classifyTestResult('--- FAIL: TestX\nFAIL\nexit status 1')).toBe('fail');
    expect(classifyTestResult('1 error in 0.05s\n(exit code: 2)')).toBe('fail');
  });
  it('strips erase-line ANSI codes (\\x1b[K) before matching', () => {
    expect(classifyTestResult('test_x.py \x1b[32m\x1b[1m5 passed\x1b[0m\x1b[K in 0.1s')).toBe('pass');
    expect(classifyTestResult('\x1b[K5 passed')).toBe('pass');
  });
  it('treats a non-zero exit as failure and zero exit as pass', () => {
    expect(classifyTestResult('something\n(exit code: 2)')).toBe('fail');
    expect(classifyTestResult('done\n(exit code: 0)')).toBe('pass');
  });
});

describe('completionGate — recordToolCall test outcomes', () => {
  const runTests = (file: string): ToolUseContentBlock => ({
    type: 'tool_use',
    id: 'id',
    name: 'run_tests',
    input: { file },
  });
  const res = (content: string): ToolResultContentBlock => ({ type: 'tool_result', tool_use_id: 'id', content });

  beforeEach(() => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/test' } }];
  });

  it('records a passing test run in BOTH testsRunForFiles and passingTestFiles', () => {
    const state = createGateState();
    recordToolCall(state, runTests('test_gui.py'), res('1 passed in 0.05s\n(exit code: 0)'));
    expect(state.testsRunForFiles.has('test_gui.py')).toBe(true);
    expect(state.passingTestFiles.has('test_gui.py')).toBe(true);
  });

  it('records a 0-collected run as ran-but-NOT-passing', () => {
    const state = createGateState();
    recordToolCall(state, runTests('test_gui.py'), res('Ran 0 tests\nNO TESTS RAN\n(exit code: 5)'));
    expect(state.testsRunForFiles.has('test_gui.py')).toBe(true);
    expect(state.passingTestFiles.has('test_gui.py')).toBe(false);
  });

  it('records a failing run as ran-but-NOT-passing', () => {
    const state = createGateState();
    recordToolCall(state, runTests('test_gui.py'), res('1 failed\n(exit code: 1)'));
    expect(state.testsRunForFiles.has('test_gui.py')).toBe(true);
    expect(state.passingTestFiles.has('test_gui.py')).toBe(false);
  });
});

describe('completionGate — buildNoFileWriteReprompt', () => {
  const userMsg = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });
  // Default: treat named files as NOT existing on disk, so the gate's
  // create-intent logic is exercised. (The real default checks the workspace.)
  const noFile = async () => false;

  it('fires when user asks to extend a test file but it was never written', async () => {
    const msgs = [userMsg('Extend `src/deps/semver.test.ts` with a describe block for semverLte.')];
    const edited = new Set<string>(['src/deps/semver.ts']);
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toContain('semver.test.ts');
  });

  it('returns null when the mentioned file was written', async () => {
    const msgs = [userMsg('Add semverLte to `src/deps/semver.ts` and extend `src/deps/semver.test.ts`.')];
    const edited = new Set<string>(['src/deps/semver.ts', 'src/deps/semver.test.ts']);
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toBeNull();
  });

  it('returns null when message has no write-intent language', async () => {
    const msgs = [userMsg('Read `src/deps/semver.ts` and explain what semverGt does.')];
    const edited = new Set<string>();
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toBeNull();
  });

  it('returns null when no file is mentioned', async () => {
    const msgs = [userMsg('Add error handling to the function.')];
    const edited = new Set<string>();
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toBeNull();
  });

  it('matches by basename when editedFiles uses a different root', async () => {
    const msgs = [userMsg('Update `src/config/tokenEstimation.test.ts` with new tests.')];
    const edited = new Set<string>(['tokenEstimation.test.ts']);
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toBeNull();
  });

  it('fires for multiple unwritten files and lists them', async () => {
    const msgs = [userMsg('Add semverLte to `src/deps/semver.ts` and tests to `src/deps/semver.test.ts`.')];
    const edited = new Set<string>();
    const result = await buildNoFileWriteReprompt(msgs, edited, undefined, noFile);
    expect(result).toContain('semver.ts');
    expect(result).toContain('semver.test.ts');
  });

  it('returns null when editedFiles is empty but there is no write-intent', async () => {
    const msgs = [userMsg('Show me what is in `src/foo.ts`.')];
    const edited = new Set<string>();
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toBeNull();
  });

  it('does NOT fire for a named file that already exists on disk (read-only dependency)', async () => {
    // Dogfood: "Build a GUI… wire to the functions already in calculator.py".
    // calculator.py exists and is a read dependency, not a missing write target.
    const msgs = [userMsg('Create `gui_calculator.py` and wire it to the functions already in `calculator.py`.')];
    const edited = new Set<string>(['gui_calculator.py']);
    const exists = async (p: string) => p.includes('calculator.py') && !p.includes('gui_');
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, exists)).toBeNull();
  });
});
