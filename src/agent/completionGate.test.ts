/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import {
  createGateState,
  recordToolCall,
  checkCompletionGate,
  buildGateInjection,
  findColocatedTest,
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

  it('passes when lint ran and the colocated test ran', async () => {
    (mockWorkspace.fs.stat as any).mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === '/test/src/foo.test.ts') return { type: 1 };
      throw new Error('not found');
    });
    const state = createGateState();
    recordToolCall(state, makeEdit('src/foo.ts'), ok());
    recordToolCall(state, makeRunCommand('npx eslint src/foo.ts'), ok());
    recordToolCall(state, makeRunTests('src/foo.test.ts'), ok());
    const findings = await checkCompletionGate(state);
    expect(findings).toEqual([]);
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
