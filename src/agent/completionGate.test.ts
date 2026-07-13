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
  buildMcpMutationVerifyReprompt,
  classifyTestResult,
  isAnalysisRequest,
  findColocatedTest,
  lastUserText,
  firstUserText,
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
    joinPath: vi.fn((base: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [base.fsPath, ...segments].join('/'),
    })),
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
/** A FAILING (but not errored) verification result — content classifies as 'fail'. */
function failing(): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: 'id', content: '1 failed, 2 passed', is_error: false };
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

// Mutation-hardening: every existing recordToolCall test used a PASSING result
// (`ok()`), so mutating any `if (passed)` branch never broke anything — the
// state ended up the same either way. These pin the FAILING path: testsRun is
// recorded either way, but passingTestFiles / projectTestsPassed must NOT be.
describe('completionGate — MCP mutation discipline', () => {
  const meta = (name: string) => {
    if (name.startsWith('mcp_jira_')) return { server: 'jira', readOnly: name.includes('get') };
    if (name.startsWith('mcp_gh_')) return { server: 'gh', readOnly: name.includes('get') };
    return undefined;
  };
  function mcpCall(name: string, input: Record<string, unknown> = {}, id = 'id'): ToolUseContentBlock {
    return { type: 'tool_use', id, name, input };
  }

  it('records a successful MCP mutation as unverified', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1', status: 'Done' }), ok(), meta);
    expect(state.mcpUnverifiedMutations!.size).toBe(1);
    const m = [...state.mcpUnverifiedMutations!.values()][0];
    expect(m.server).toBe('jira');
    expect(m.tool).toBe('mcp_jira_update_issue');
    expect(m.inputSummary).toContain('"status":"Done"');
  });

  it('a later read-only call to the same server verifies its mutations', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1' }, 'a'), ok(), meta);
    recordToolCall(state, mcpCall('mcp_jira_get_issue', { issue: 'X-1' }, 'b'), ok(), meta);
    expect(state.mcpUnverifiedMutations!.size).toBe(0);
  });

  it('a read-only call to a DIFFERENT server does not verify', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1' }, 'a'), ok(), meta);
    recordToolCall(state, mcpCall('mcp_gh_get_issue', { number: 5 }, 'b'), ok(), meta);
    expect(state.mcpUnverifiedMutations!.size).toBe(1);
  });

  it('an errored mutation is not tracked (the model already sees the failure)', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1' }), err(), meta);
    expect(state.mcpUnverifiedMutations!.size).toBe(0);
  });

  it('an errored read-back does NOT verify a prior mutation', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1' }, 'a'), ok(), meta);
    recordToolCall(state, mcpCall('mcp_jira_get_issue', { issue: 'X-1' }, 'b'), err(), meta);
    expect(state.mcpUnverifiedMutations!.size).toBe(1);
  });

  it('MCP names without resolvable meta are ignored', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_unknown_write', {}), ok(), meta);
    expect(state.mcpUnverifiedMutations!.size).toBe(0);
  });

  it('without a meta lookup (no manager) MCP calls are ignored entirely', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1' }), ok());
    expect(state.mcpUnverifiedMutations!.size).toBe(0);
  });

  it('truncates huge mutation inputs in the summary', () => {
    const state = createGateState();
    recordToolCall(state, mcpCall('mcp_jira_update_issue', { body: 'x'.repeat(5000) }), ok(), meta);
    const m = [...state.mcpUnverifiedMutations!.values()][0];
    expect(m.inputSummary.length).toBeLessThanOrEqual(301);
    expect(m.inputSummary.endsWith('…')).toBe(true);
  });

  describe('delegate_to_mcp tracking', () => {
    function wrappedResult(): ToolResultContentBlock {
      return {
        type: 'tool_result',
        tool_use_id: 'id',
        content: '<mcp_tool_output server="jira" tool="run_task" trust="untrusted">\ndone\n</mcp_tool_output>',
      };
    }

    it('records a successful delegation as an unverified mutation to that server', () => {
      const state = createGateState();
      recordToolCall(
        state,
        mcpCall('delegate_to_mcp', { server: 'jira', task: 'close stale issues' }),
        wrappedResult(),
      );
      expect(state.mcpUnverifiedMutations!.size).toBe(1);
      const m = [...state.mcpUnverifiedMutations!.values()][0];
      expect(m).toMatchObject({ server: 'jira', tool: 'delegate_to_mcp' });
    });

    it('ignores delegation failures reported as plain content (no boundary wrap)', () => {
      const state = createGateState();
      recordToolCall(state, mcpCall('delegate_to_mcp', { server: 'jira', task: 'x' }), {
        type: 'tool_result',
        tool_use_id: 'id',
        content: 'Server "jira" is not connected. Connected servers: (none)',
      });
      expect(state.mcpUnverifiedMutations!.size).toBe(0);
    });

    it('a later read-only call to the delegated server verifies the delegation', () => {
      const state = createGateState();
      recordToolCall(state, mcpCall('delegate_to_mcp', { server: 'jira', task: 'x' }, 'a'), wrappedResult());
      recordToolCall(state, mcpCall('mcp_jira_get_issue', { issue: 'X-1' }, 'b'), ok(), meta);
      expect(state.mcpUnverifiedMutations!.size).toBe(0);
    });

    it('tracks without a meta lookup (delegation carries its own server attribution)', () => {
      const state = createGateState();
      recordToolCall(state, mcpCall('delegate_to_mcp', { server: 'jira', task: 'x' }), wrappedResult());
      expect(state.mcpUnverifiedMutations!.size).toBe(1);
    });
  });

  describe('buildMcpMutationVerifyReprompt', () => {
    it('returns null when nothing is unverified', () => {
      expect(buildMcpMutationVerifyReprompt(createGateState())).toBeNull();
    });

    it('returns null for a back-compat stub state without the map', () => {
      const state = createGateState();
      delete state.mcpUnverifiedMutations;
      expect(buildMcpMutationVerifyReprompt(state)).toBeNull();
    });

    it('lists each unverified mutation with server and input, and the draft-on-mismatch rule', () => {
      const state = createGateState();
      recordToolCall(state, mcpCall('mcp_jira_update_issue', { issue: 'X-1', status: 'Done' }, 'a'), ok(), meta);
      recordToolCall(state, mcpCall('mcp_gh_create_issue', { title: 'Bug' }, 'b'), ok(), meta);
      const reprompt = buildMcpMutationVerifyReprompt(state)!;
      expect(reprompt).toContain('mcp_jira_update_issue (server "jira")');
      expect(reprompt).toContain('mcp_gh_create_issue (server "gh")');
      expect(reprompt).toContain('"status":"Done"');
      expect(reprompt).toContain('read tool from the same MCP server');
      expect(reprompt).toContain('draft');
    });
  });
});

describe('completionGate — recordToolCall failing-result hardening', () => {
  it('run_tests with a file that FAILS: tracked as run, NOT as passing', () => {
    const state = createGateState();
    recordToolCall(state, makeRunTests('src/foo.test.ts'), failing());
    expect([...state.testsRunForFiles]).toEqual(['src/foo.test.ts']);
    expect([...state.passingTestFiles]).toEqual([]);
  });

  it('run_tests with a file OUTSIDE the workspace root: normalizePath→null, nothing recorded', () => {
    const state = createGateState();
    recordToolCall(state, makeRunTests('/etc/passwd'), ok());
    expect(state.testsRunForFiles.size).toBe(0);
  });

  it('run_tests whole-project that FAILS: ran=true, passed=false', () => {
    const state = createGateState();
    recordToolCall(state, makeRunTests(), failing());
    expect(state.projectTestsRan).toBe(true);
    expect(state.projectTestsPassed).toBe(false);
  });

  it('run_command test-runner match with a file that FAILS: run, not passing', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx vitest run src/foo.test.ts'), failing());
    expect([...state.testsRunForFiles]).toEqual(['src/foo.test.ts']);
    expect([...state.passingTestFiles]).toEqual([]);
  });

  it('run_command test-runner match with NO file (whole project) that FAILS', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npx vitest run'), failing());
    expect(state.projectTestsRan).toBe(true);
    expect(state.projectTestsPassed).toBe(false);
  });

  it('run_command "npm test" whole-suite that FAILS', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('npm test'), failing());
    expect(state.projectTestsRan).toBe(true);
    expect(state.projectTestsPassed).toBe(false);
  });

  it('run_command with NO test-runner keyword at all: state untouched (testMatch is null)', () => {
    const state = createGateState();
    recordToolCall(state, makeRunCommand('echo hello'), ok());
    expect(state.testsRunForFiles.size).toBe(0);
    expect(state.projectTestsRan).toBe(false);
  });

  it('is_error short-circuits BEFORE any classification, even for run_tests', () => {
    const state = createGateState();
    recordToolCall(state, makeRunTests('src/foo.test.ts'), err());
    expect(state.testsRunForFiles.size).toBe(0);
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
    // Exclusivity: no missingTest/testNotUpdated findings here — kills the
    // `.length >= 0` mutants that would render these sections unconditionally.
    expect(text).not.toContain('Tests for the files you edited have not run');
    expect(text).not.toContain('did not update their test files');
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
    // Exclusivity: no needsLint/testNotUpdated findings here.
    expect(text).not.toContain('static check');
    expect(text).not.toContain('did not update their test files');
  });

  it('includes a test-update section ONLY when testNotUpdated findings exist', () => {
    const text = buildGateInjection([{ file: 'src/foo.ts', testNotUpdated: 'src/foo.test.ts' }], 1, 2);
    expect(text).toContain('did not update their test files');
    expect(text).toContain('src/foo.ts  ->  src/foo.test.ts');
    expect(text).not.toContain('static check');
    expect(text).not.toContain('Tests for the files you edited have not run');
  });

  it('an empty findings array renders none of the three optional sections', () => {
    const text = buildGateInjection([], 1, 2);
    expect(text).not.toContain('static check');
    expect(text).not.toContain('Tests for the files you edited have not run');
    expect(text).not.toContain('did not update their test files');
    // The directive header still renders regardless.
    expect(text).toContain('Completion gate');
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

  // Mutation-hardening for hasReadToolCallForFile's guard chain.
  it('an assistant message with STRING content does not satisfy the check', () => {
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      { role: 'assistant' as const, content: 'ok, reading now' },
    ];
    expect(buildNoReadReprompt(msgs)).not.toBeNull();
  });

  it('a non-tool_use block does not satisfy the check', () => {
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'looking' }] },
    ];
    expect(buildNoReadReprompt(msgs)).not.toBeNull();
  });

  it('a read-capable tool call for a DIFFERENT file does not satisfy the requirement', () => {
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      assistantToolMsg('read_file', { path: 'src/unrelated.ts' }),
    ];
    expect(buildNoReadReprompt(msgs)).not.toBeNull();
  });

  it('finds the matching read call as the SECOND block (loop continues past a non-match)', () => {
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'let me check' }, tool('read_file', { path: 'src/greeter.ts' })],
      },
    ];
    expect(buildNoReadReprompt(msgs)).toBeNull();
  });

  it('grep also counts as a read-capable tool (name-set coverage), matched case-insensitively', () => {
    const msgs = [
      userMsg('Read src/GREETER.ts and tell me what it does.'),
      assistantToolMsg('grep', { pattern: 'class', path: 'src/greeter.ts' }),
    ];
    expect(buildNoReadReprompt(msgs)).toBeNull();
  });

  // Adversarial guard-bypass cases: constructed so that if the role filter or
  // the block-shape guard were REMOVED (mutated to always-false / never-skip),
  // the check would incorrectly find a match. A same-shaped-but-benign test
  // can't distinguish "guard correctly skipped this" from "guard was a no-op
  // and there was nothing to match anyway" — these can.
  it('a matching read_file call under role "user" must NOT satisfy the assistant-only check', () => {
    // If the `msg.role !== 'assistant'` guard were mutated to never-skip, this
    // well-formed match under the WRONG role would incorrectly satisfy it.
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      { role: 'user' as const, content: [tool('read_file', { path: 'src/greeter.ts' })] },
    ];
    expect(buildNoReadReprompt(msgs)).not.toBeNull();
  });

  it('a non-tool_use block that HAPPENS to carry a matching name+input must NOT satisfy the check', () => {
    // If the `b.type !== 'tool_use'` guard were removed, this text block —
    // which carries a read_file-shaped name/input by coincidence — would
    // incorrectly satisfy the requirement.
    const msgs = [
      userMsg('Read src/greeter.ts and tell me what it does.'),
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'x', name: 'read_file', input: { path: 'src/greeter.ts' } } as any],
      },
    ];
    expect(buildNoReadReprompt(msgs)).not.toBeNull();
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

  // Mutation-hardening: pin every guard in the backward-scan loop + the
  // block-shape checks (kills the EqualityOperator `i > 0`/`i >= 0` boundary
  // mutant and the LogicalOperator/ConditionalExpression chain on each block).
  it('BOUNDARY: finds the user message at index 0 (kills the i>0 vs i>=0 mutant)', () => {
    // Only ONE message, at index 0 — a mutated `i > 0` would skip it (loop body
    // never runs at i=0), producing '' instead of the real text.
    const msgs = [{ role: 'user' as const, content: 'only message' }];
    expect(lastUserText(msgs)).toBe('only message');
  });

  it('skips a non-text block before finding the text block in the same message', () => {
    const msgs = [
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'x', content: 'irrelevant' },
          { type: 'text' as const, text: 'the real question' },
        ],
      },
    ];
    expect(lastUserText(msgs)).toBe('the real question');
  });

  it('array content with no text block at all yields empty string, not a crash', () => {
    const msgs = [
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'x', content: 'x' }] },
    ];
    expect(lastUserText(msgs)).toBe('');
  });

  it('skips an assistant message sandwiched between two user messages', () => {
    const msgs = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'second' },
    ];
    expect(lastUserText(msgs)).toBe('second');
  });

  it('a trailing assistant message with array-text content must NOT satisfy the user-only check', () => {
    // If the `msg.role !== 'user'` guard were mutated to never-skip, the scan
    // (which runs backward) would return the assistant's text instead.
    const msgs = [
      { role: 'user' as const, content: 'the real question' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ASSISTANT REPLY' }] },
    ];
    expect(lastUserText(msgs)).toBe('the real question');
  });

  it('a non-text block with a coincidental `.text` property must NOT be returned', () => {
    // If the `b.type === 'text'` guard were removed, this tool_result block —
    // which happens to carry a `.text` field — would be returned instead of
    // the real text block that follows it.
    const msgs = [
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'x', content: 'y', text: 'WRONG' } as any,
          { type: 'text' as const, text: 'the real question' },
        ],
      },
    ];
    expect(lastUserText(msgs)).toBe('the real question');
  });
});

describe('completionGate — firstUserText', () => {
  it('returns the FIRST user message, not the last (opposite of lastUserText)', () => {
    const msgs = [
      { role: 'user' as const, content: 'original task' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'follow-up' },
    ];
    expect(firstUserText(msgs)).toBe('original task');
  });

  it('returns empty string when there are no user messages', () => {
    expect(firstUserText([{ role: 'assistant' as const, content: 'hi' }])).toBe('');
  });

  it('skips a leading assistant message to find the first user one', () => {
    const msgs = [
      { role: 'assistant' as const, content: 'system greeting' },
      { role: 'user' as const, content: 'the actual task' },
    ];
    expect(firstUserText(msgs)).toBe('the actual task');
  });

  it('extracts text from an array-content user message', () => {
    const msgs = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'array form' }] }];
    expect(firstUserText(msgs)).toBe('array form');
  });

  it('skips a non-text block to find the text block after it', () => {
    const msgs = [
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'x', content: 'noise' },
          { type: 'text' as const, text: 'the question' },
        ],
      },
    ];
    expect(firstUserText(msgs)).toBe('the question');
  });

  it('array content with no text block yields empty string', () => {
    const msgs = [
      { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'x', content: 'x' }] },
    ];
    expect(firstUserText(msgs)).toBe('');
  });

  it('a LEADING assistant message with array-text content must NOT satisfy the user-only check', () => {
    const msgs = [
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ASSISTANT REPLY' }] },
      { role: 'user' as const, content: 'the real question' },
    ];
    expect(firstUserText(msgs)).toBe('the real question');
  });

  it('a non-text block with a coincidental `.text` property must NOT be returned', () => {
    const msgs = [
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'x', content: 'y', text: 'WRONG' } as any,
          { type: 'text' as const, text: 'the real question' },
        ],
      },
    ];
    expect(firstUserText(msgs)).toBe('the real question');
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

  // Mutation-hardening for hasRunCommandCall's guard chain: role filter,
  // Array.isArray(content) filter, block-shape checks, and tool-name match.
  it('an assistant message with STRING content (no array) does not satisfy the check', () => {
    const msgs = [
      userMsg('How many test files are in src/?'),
      { role: 'assistant' as const, content: 'I will check that for you.' },
    ];
    expect(buildNoShellReprompt(msgs)).not.toBeNull(); // string content ⇒ no tool call found ⇒ still fires
  });

  it('a non-tool_use block (e.g. text) in the array does not satisfy the check', () => {
    const msgs = [
      userMsg('How many test files are in src/?'),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'let me think' }] },
    ];
    expect(buildNoShellReprompt(msgs)).not.toBeNull();
  });

  it('a DIFFERENT tool call (not run_command) does not satisfy the check', () => {
    const msgs = [
      userMsg('How many test files are in src/?'),
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'x', name: 'read_file', input: { path: 'a.ts' } }],
      },
    ];
    expect(buildNoShellReprompt(msgs)).not.toBeNull();
  });

  it('finds run_command as the SECOND block in the content array (loop continues past a non-match)', () => {
    const msgs = [
      userMsg('How many test files are in src/?'),
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'checking now' },
          { type: 'tool_use' as const, id: 'x', name: 'run_command', input: { command: 'wc -l src/*.ts' } },
        ],
      },
    ];
    expect(buildNoShellReprompt(msgs)).toBeNull();
  });

  it('a user message with tool_use-shaped content is ignored (role filter, not content shape)', () => {
    // Malformed/unusual input: a tool_use block under role 'user' must NOT
    // satisfy the assistant-only check.
    const msgs = [
      userMsg('How many test files are in src/?'),
      {
        role: 'user' as const,
        content: [{ type: 'tool_use' as const, id: 'x', name: 'run_command', input: { command: 'wc -l' } }],
      },
    ];
    expect(buildNoShellReprompt(msgs)).not.toBeNull();
  });

  it('a non-tool_use block that HAPPENS to carry name="run_command" must NOT satisfy the check', () => {
    // If the block-shape/type guard were removed, this text block — carrying a
    // run_command-shaped `name` by coincidence — would incorrectly match.
    const msgs = [
      userMsg('How many test files are in src/?'),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'x', name: 'run_command' } as any] },
    ];
    expect(buildNoShellReprompt(msgs)).not.toBeNull();
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

  // Mutation-hardening for hasAnyGroundingToolCall's guard chain.
  it('an assistant message with STRING content does not satisfy the check', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      { role: 'assistant' as const, content: 'Sure, let me look.' },
    ];
    expect(buildNoGroundingReprompt(msgs)).not.toBeNull();
  });

  it('a non-tool_use block does not satisfy the check', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'thinking...' }] },
    ];
    expect(buildNoGroundingReprompt(msgs)).not.toBeNull();
  });

  it('a non-grounding tool call (e.g. write_file) does not satisfy the check', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantToolMsg('write_file', { path: 'notes.md', content: 'x' }),
    ];
    expect(buildNoGroundingReprompt(msgs)).not.toBeNull();
  });

  it('finds a grounding tool as the SECOND block (loop continues past a non-match)', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'let me check' },
          { type: 'tool_use' as const, id: 'x', name: 'grep', input: { pattern: 'class' } },
        ],
      },
    ];
    expect(buildNoGroundingReprompt(msgs)).toBeNull();
  });

  it('list_directory and search_files also count as grounding (full name-set coverage)', () => {
    expect(
      buildNoGroundingReprompt([
        userMsg('Review the architecture.'),
        assistantToolMsg('list_directory', { path: '.' }),
      ]),
    ).toBeNull();
    expect(
      buildNoGroundingReprompt([
        userMsg('Review the architecture.'),
        assistantToolMsg('search_files', { query: 'auth' }),
      ]),
    ).toBeNull();
  });

  it('a matching read_file call under role "user" must NOT satisfy the assistant-only check', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      { role: 'user' as const, content: [{ type: 'tool_use' as const, id: 'x', name: 'read_file', input: {} }] },
    ];
    expect(buildNoGroundingReprompt(msgs)).not.toBeNull();
  });

  it('a non-tool_use block that HAPPENS to carry a grounding tool name must NOT satisfy the check', () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'x', name: 'read_file' } as any] },
    ];
    expect(buildNoGroundingReprompt(msgs)).not.toBeNull();
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

  it('resolves bare-basename citations via the suffix probe (prose cites "loop.ts", not the full path)', async () => {
    // Root-relative-only matching flagged every basename mention as a
    // fabrication — measured 85% "unresolved" in BOTH ablation arms: pure
    // noise that drowned the gate's real signal AND false-accused the model.
    const suffixExists = async (s: string) => [...realFiles].some((k) => k === s || k.endsWith('/' + s));
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('The streaming logic in `loop.ts` is clean, and `messageBuild.ts` composes results.'),
    ];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists, undefined, suffixExists)).toBeNull();
  });

  it('resolves partial-path citations ("agent/loop.ts") via the suffix probe', async () => {
    const suffixExists = async (s: string) => [...realFiles].some((k) => k === s || k.endsWith('/' + s));
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('See `agent/loop.ts` for the orchestration.'),
    ];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists, undefined, suffixExists)).toBeNull();
  });

  it('still fires on a true fabrication even with the suffix probe active', async () => {
    const suffixExists = async (s: string) => [...realFiles].some((k) => k === s || k.endsWith('/' + s));
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('The resolver in `src/context/resolveToolOutput.ts` handles this.'),
    ];
    const result = await buildUnverifiedClaimReprompt(msgs, fileExists, undefined, suffixExists);
    expect(result).not.toBeNull();
    expect(result).toContain('resolveToolOutput.ts');
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

  it('returns null for an explicitly empty requestText (distinct from "no messages")', async () => {
    const msgs = [assistantMsg('The loop (`src/agent/loop.ts`) is well structured.')];
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists, '')).toBeNull();
  });

  it('deduplicates a citation repeated twice — flagged once, not per-occurrence', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('`src/context/context.ts` handles this, and `src/context/context.ts` is used throughout.'),
    ];
    const result = await buildUnverifiedClaimReprompt(msgs, fileExists);
    expect(result).not.toBeNull();
    // Cited once in the reprompt body despite two occurrences in the answer.
    expect((result!.match(/context\/context\.ts/g) || []).length).toBe(1);
  });

  it('singular wording for exactly one fabricated path', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('Handled in `src/context/context.ts`.'),
    ];
    const result = await buildUnverifiedClaimReprompt(msgs, fileExists);
    expect(result).toContain('a path that does not exist');
    expect(result).not.toContain('paths that do not exist');
  });

  it('plural wording for two or more fabricated paths', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('See `src/context/context.ts` and `src/context/other.ts`.'),
    ];
    const result = await buildUnverifiedClaimReprompt(msgs, fileExists);
    expect(result).toContain('paths that do not exist');
    expect(result).not.toContain('a path that does not exist');
  });

  // Mutation-hardening for lastAssistantText's guard chain (same technique as
  // lastUserText/firstUserText — same-shape-but-benign tests can't distinguish
  // "guard correctly skipped" from "nothing to match anyway").
  it('a trailing user message with array-text content must NOT satisfy the assistant-only check', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      assistantMsg('Handled in `src/context/context.ts`.'),
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'thanks' }] },
    ];
    // If the assistant-only guard were bypassed, the trailing user text would
    // be scanned instead — it cites nothing, so the reprompt would wrongly
    // return null. Confirms the real (fabricated) answer is still used.
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists)).not.toBeNull();
  });

  it('a non-text block with a coincidental `.text` property must NOT be returned', async () => {
    const msgs = [
      userMsg('Review the architecture of this project.'),
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'x', content: 'y', text: 'src/context/context.ts' } as any,
          { type: 'text' as const, text: 'Handled in `src/agent/loop.ts`, which is real.' },
        ],
      },
    ];
    // If the type==='text' guard were bypassed, the coincidental `.text` field
    // (a fabricated citation) would be scanned instead of the real, clean answer.
    expect(await buildUnverifiedClaimReprompt(msgs, fileExists)).toBeNull();
  });

  it('array-content assistant message with STRING content still concatenates via join (no crash)', async () => {
    // lastAssistantText on array content returns filter().map().join('\n') —
    // an array with ZERO text blocks joins to '' (falsy), which must be
    // treated the same as "no answer yet".
    const msgs = [
      userMsg('Review the architecture of this project.'),
      { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 'x', name: 'read_file', input: {} }] },
    ];
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
    // Exclusivity: no hollow test exists here (nothing ran at all), so the
    // hollow-specific wording must be ABSENT — kills the `hollow.length >= 0`
    // mutant that would render this section even when hollow.length is 0.
    expect(r).not.toContain('never imports the module under test');
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

  // Mutation-hardening for candidateTestFiles: every test above edits a BARE
  // filename (no directory), so `dir` is always '' and the `slash !== -1`
  // dir-prefixed-candidate branch is never exercised. This proves it works
  // for a nested file, via the whole-suite conventional-test-file path.
  it('finds a dir-prefixed conventional test file for a nested source path', async () => {
    const nestedEdited = new Set<string>(['src/calc.py']);
    const suite = {
      testsRunForFiles: new Set<string>(),
      passingTestFiles: new Set<string>(),
      projectTestsPassed: true,
    };
    // Only the dir-prefixed candidate ("src/test_calc.py") has content —
    // proves candidateTestFiles actually generated and checked it.
    const readNested = async (p: string) => (p === 'src/test_calc.py' ? 'from calc import add\n' : null);
    expect(await buildBehavioralVerificationReprompt('the calc is broken', nestedEdited, suite, readNested)).toBeNull();
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
    // Exclusivity: gui_calculator.py was found via the hollow path, not pushed
    // to `uncovered` — kills the `uncovered.length >= 0` mutant that would
    // render the uncovered-files section even when uncovered.length is 0.
    expect(r).not.toContain('You edited code');
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

  // Mutation-hardening: pin each exclusion clause in the behavioralEdits
  // filter (SOURCE_FILE_RE && !.d.ts && !TEST_FILE_RE && !PY_TEST_FILE_RE)
  // independently, so a removed clause breaks a test instead of silently
  // widening what counts as "behavioral source".
  it('excludes a .d.ts declaration file — no behavioral obligation for type-only edits', async () => {
    const onlyTypes = new Set<string>(['calculator.d.ts']);
    expect(await buildBehavioralVerificationReprompt('the gui is broken', onlyTypes, noTests)).toBeNull();
  });

  it('excludes a JS/TS test file (TEST_FILE_RE) even without the .py convention', async () => {
    const onlyJsTest = new Set<string>(['calculator.test.ts']);
    expect(await buildBehavioralVerificationReprompt('the app is broken', onlyJsTest, noTests)).toBeNull();
  });

  it('excludes a non-source file entirely (fails SOURCE_FILE_RE)', async () => {
    const onlyDocs = new Set<string>(['README.md']);
    expect(await buildBehavioralVerificationReprompt('the app is broken', onlyDocs, noTests)).toBeNull();
  });

  it('a mixed edit set still obligates the ONE genuinely-behavioral file', async () => {
    // .d.ts and the test file itself are excluded; the actual source file
    // still needs a behavioral test — proves the exclusions filter
    // per-file, not all-or-nothing.
    const mixed = new Set<string>(['gui_calculator.py', 'gui_calculator.d.ts', 'test_gui_calculator.py']);
    const r = await buildBehavioralVerificationReprompt('the gui is broken', mixed, noTests);
    expect(r).not.toBeNull();
    expect(r).toContain('gui_calculator.py');
    expect(r).not.toContain('gui_calculator.d.ts');
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

// Mutation-hardening: pin every branch + boundary so a flipped condition/operator
// in the classifier is caught (the completion gate's most load-bearing decision —
// misreading a pass as fail makes it loop, misreading a fail as pass ships bugs).
describe('completionGate — classifyTestResult branch + boundary hardening', () => {
  it('each EMPTY trigger in isolation', () => {
    for (const s of [
      'no tests ran',
      'Ran 0 tests in 0.0s',
      'collected 0 items',
      '0 tests passed',
      '0 tests collected',
    ]) {
      expect(classifyTestResult(s)).toBe('empty');
    }
    expect(classifyTestResult('done\n(exit code: 5)')).toBe('empty'); // exit 5 = pytest "no tests"
  });

  it('each FAIL trigger in isolation', () => {
    expect(classifyTestResult('3 failed')).toBe('fail');
    expect(classifyTestResult('2 errors')).toBe('fail');
    expect(classifyTestResult('1 error')).toBe('fail');
    expect(classifyTestResult('FAILED')).toBe('fail');
    expect(classifyTestResult('FAIL')).toBe('fail');
    expect(classifyTestResult('AssertionError: nope')).toBe('fail');
    expect(classifyTestResult('Traceback (most recent call last):')).toBe('fail');
    expect(classifyTestResult('x\n(exit code: 1)')).toBe('fail');
  });

  it('each PASS trigger in isolation', () => {
    expect(classifyTestResult('7 passed')).toBe('pass');
    expect(classifyTestResult('7 passing')).toBe('pass');
    expect(classifyTestResult('ran everything\nOK')).toBe('pass');
    expect(classifyTestResult('all tests passed')).toBe('pass');
    expect(classifyTestResult('x\n(exit code: 0)')).toBe('pass');
  });

  it('BOUNDARY: a zero count is not a fail/pass (kills the [1-9] digit boundary)', () => {
    // "0 failed" must NOT read as fail; "0 passed" must NOT read as pass. With no
    // other signal + no exit code, both are 'unknown'.
    expect(classifyTestResult('0 failed')).toBe('unknown');
    expect(classifyTestResult('0 errors')).toBe('unknown');
    expect(classifyTestResult('0 passed')).toBe('unknown');
  });

  it('PRECEDENCE: exit 5 → empty even alongside a passing count', () => {
    // exit===5 (empty) is checked before the pass branch — pins that ordering.
    expect(classifyTestResult('no tests ran\n5 passed earlier\n(exit code: 5)')).toBe('empty');
  });

  it('unrecognized output is unknown, not a false pass/fail', () => {
    expect(classifyTestResult('building project...')).toBe('unknown');
    expect(classifyTestResult('')).toBe('unknown');
  });
});

describe('completionGate — isAnalysisRequest (verb AND target, kills the && mutation)', () => {
  it('true only when BOTH an analysis verb and a code target are present', () => {
    expect(isAnalysisRequest('review the codebase')).toBe(true);
    expect(isAnalysisRequest('audit this project')).toBe(true);
    expect(isAnalysisRequest('inspect the architecture')).toBe(true);
    expect(isAnalysisRequest('analyze the implementation')).toBe(true);
    expect(isAnalysisRequest('critique the design')).toBe(true);
  });

  it('false with a verb but NO code target (kills && → ||)', () => {
    expect(isAnalysisRequest('review this')).toBe(false);
    expect(isAnalysisRequest('please assess it')).toBe(false);
    expect(isAnalysisRequest('evaluate the results')).toBe(false);
  });

  it('false with a target but NO analysis verb (kills && → || the other way)', () => {
    expect(isAnalysisRequest('the codebase is large')).toBe(false);
    expect(isAnalysisRequest('open the architecture doc')).toBe(false);
  });

  it('false when neither is present', () => {
    expect(isAnalysisRequest('hello there')).toBe(false);
    expect(isAnalysisRequest('')).toBe(false);
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

  // Mutation-hardening: pin the wasWritten match paths + pluralization.
  it('matches via the suffix path (f.endsWith("/"+base)) — neither exact nor bare-basename match applies', async () => {
    // editedFiles holds a path that ends with the mentioned basename but is
    // NEITHER the exact mentioned path NOR the bare basename itself — only
    // the third `.some(f => f.endsWith('/' + base) ...)` disjunct can match.
    const msgs = [userMsg('Extend `src/deps/semver.test.ts` with a describe block for semverLte.')];
    const edited = new Set<string>(['other/nested/semver.test.ts']);
    expect(await buildNoFileWriteReprompt(msgs, edited, undefined, noFile)).toBeNull();
  });

  it('singular wording ("it" / "that file") for exactly one unwritten file', async () => {
    const msgs = [userMsg('Add semverLte to `src/deps/semver.ts`.')];
    const result = await buildNoFileWriteReprompt(msgs, new Set(), undefined, noFile);
    expect(result).toContain('finished without writing to it');
    expect(result).toContain('changes to that file');
    expect(result).not.toContain('any of them');
    expect(result).not.toContain('those files');
  });

  it('plural wording ("any of them" / "those files") for two or more unwritten files', async () => {
    const msgs = [userMsg('Add semverLte to `src/deps/semver.ts` and tests to `src/deps/semver.test.ts`.')];
    const result = await buildNoFileWriteReprompt(msgs, new Set(), undefined, noFile);
    expect(result).toContain('finished without writing to any of them');
    expect(result).toContain('changes to those files');
    expect(result).not.toContain('writing to it.');
  });

  it('uses the real defaultFileExists (default param) against the mocked workspace', async () => {
    // No custom fileExists injected — exercises the actual workspace.fs.stat
    // path. Configured to say the file does NOT exist, so the gate fires.
    (mockWorkspace.fs.stat as any).mockRejectedValue(new Error('not found'));
    const msgs = [userMsg('Create `src/deps/newmath.ts` with a clamp function.')];
    const result = await buildNoFileWriteReprompt(msgs, new Set());
    expect(result).not.toBeNull();
    expect(result).toContain('newmath.ts');
  });

  it('the real defaultFileExists returns null (no fire) when workspace.fs.stat resolves', async () => {
    (mockWorkspace.fs.stat as any).mockResolvedValue(undefined);
    const msgs = [userMsg('Create `src/deps/newmath.ts` with a clamp function.')];
    expect(await buildNoFileWriteReprompt(msgs, new Set())).toBeNull();
  });
});

describe('no-op edits are not mutations (completion recognition)', () => {
  it('does not record a "No change needed" edit as an edit or reset lint evidence', () => {
    // v0.119 dogfood: after a successful rename the model re-sent the same
    // edit. Counting that no-op as a mutation reset lintObserved and made the
    // gate demand re-verification of already-verified work — fuel for the loop.
    const state = createGateState();
    state.lintObserved = true;

    recordToolCall(
      state,
      { type: 'tool_use', id: '1', name: 'edit_file', input: { path: 'src/greeter.ts' } },
      {
        type: 'tool_result',
        tool_use_id: '1',
        content: 'No change needed: src/greeter.ts already contains the result of this edit.',
      },
    );

    expect(state.editedFiles.size).toBe(0);
    expect(state.lintObserved).toBe(true);
  });

  it('still records a real edit and invalidates prior lint evidence', () => {
    const state = createGateState();
    state.lintObserved = true;

    recordToolCall(
      state,
      { type: 'tool_use', id: '2', name: 'edit_file', input: { path: 'src/greeter.ts' } },
      { type: 'tool_result', tool_use_id: '2', content: 'File edited: src/greeter.ts' },
    );

    expect(state.editedFiles.size).toBe(1);
    expect(state.lintObserved).toBe(false);
  });
});
