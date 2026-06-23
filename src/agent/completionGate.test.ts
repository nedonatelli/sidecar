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
  it('includes a lint command section when needsLint findings exist', () => {
    const text = buildGateInjection([{ file: 'src/foo.ts', needsLint: true }], 1, 2);
    expect(text).toContain('Lint has not run this turn');
    expect(text).toContain('npx eslint src/foo.ts');
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

  it('no-file-write gate respects requestText (does not fire on stale original-prompt files)', () => {
    const msgs = [userMsg('Create calculator.py and write test_calculator.py.')];
    // Stale anchor: fires for the original files not written this run.
    expect(buildNoFileWriteReprompt(msgs, new Set(['gui_calculator.py']))).not.toBeNull();
    // Current-turn anchor mentions only gui_calculator.py, which IS edited → no fire.
    expect(
      buildNoFileWriteReprompt(
        msgs,
        new Set(['gui_calculator.py']),
        'write changes to gui_calculator.py to add a button',
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

describe('completionGate — buildNoFileWriteReprompt', () => {
  const userMsg = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] });

  it('fires when user asks to extend a test file but it was never written', () => {
    const msgs = [userMsg('Extend `src/deps/semver.test.ts` with a describe block for semverLte.')];
    const edited = new Set<string>(['src/deps/semver.ts']);
    expect(buildNoFileWriteReprompt(msgs, edited)).toContain('semver.test.ts');
  });

  it('returns null when the mentioned file was written', () => {
    const msgs = [userMsg('Add semverLte to `src/deps/semver.ts` and extend `src/deps/semver.test.ts`.')];
    const edited = new Set<string>(['src/deps/semver.ts', 'src/deps/semver.test.ts']);
    expect(buildNoFileWriteReprompt(msgs, edited)).toBeNull();
  });

  it('returns null when message has no write-intent language', () => {
    const msgs = [userMsg('Read `src/deps/semver.ts` and explain what semverGt does.')];
    const edited = new Set<string>();
    expect(buildNoFileWriteReprompt(msgs, edited)).toBeNull();
  });

  it('returns null when no file is mentioned', () => {
    const msgs = [userMsg('Add error handling to the function.')];
    const edited = new Set<string>();
    expect(buildNoFileWriteReprompt(msgs, edited)).toBeNull();
  });

  it('matches by basename when editedFiles uses a different root', () => {
    const msgs = [userMsg('Update `src/config/tokenEstimation.test.ts` with new tests.')];
    const edited = new Set<string>(['tokenEstimation.test.ts']);
    expect(buildNoFileWriteReprompt(msgs, edited)).toBeNull();
  });

  it('fires for multiple unwritten files and lists them', () => {
    const msgs = [userMsg('Add semverLte to `src/deps/semver.ts` and tests to `src/deps/semver.test.ts`.')];
    const edited = new Set<string>();
    const result = buildNoFileWriteReprompt(msgs, edited);
    expect(result).toContain('semver.ts');
    expect(result).toContain('semver.test.ts');
  });

  it('returns null when editedFiles is empty but there is no write-intent', () => {
    const msgs = [userMsg('Show me what is in `src/foo.ts`.')];
    const edited = new Set<string>();
    expect(buildNoFileWriteReprompt(msgs, edited)).toBeNull();
  });
});
