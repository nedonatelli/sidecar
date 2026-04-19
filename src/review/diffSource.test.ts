import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ exec: vi.fn() }));
import { exec } from 'child_process';

import { fetchWorkingTreeDiff, fetchBranchRangeDiff } from './diffSource.js';

// ---------------------------------------------------------------------------
// Tests for diffSource.ts (v0.68 chunk 1).
//
// Pure git-wrapper primitive. Tests cover the fallback cascade
// (working → staged), truncation semantics, empty + error paths,
// branch-range fetches, and the ref-safety regex on caller input.
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

/**
 * Install a child_process.exec mock keyed by command prefix. Calls
 * matching a key in `outputs` resolve with that stdout; calls in
 * `fail` reject with a synthesized error; unmatched calls throw.
 */
function installExec(outputs: Record<string, string>, fail: Set<string> = new Set()): void {
  const execMock = exec as unknown as ReturnType<typeof vi.fn>;
  execMock.mockImplementation((cmd: string, _opts: unknown, cb?: ExecCallback) => {
    const callback = typeof _opts === 'function' ? (_opts as ExecCallback) : cb;
    for (const key of Object.keys(outputs)) {
      if (cmd.startsWith(key)) {
        if (fail.has(key)) {
          callback?.(new Error(`simulated failure for ${key}`), { stdout: '', stderr: 'fatal' });
          return;
        }
        callback?.(null, { stdout: outputs[key], stderr: '' });
        return;
      }
    }
    callback?.(new Error(`unexpected exec: ${cmd}`), { stdout: '', stderr: '' });
  });
}

beforeEach(() => {
  (exec as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe('fetchWorkingTreeDiff', () => {
  it('returns the working-tree diff when HEAD has unstaged changes', async () => {
    installExec({ 'git diff HEAD': 'diff --git a/x b/x\n+added\n' });
    const result = await fetchWorkingTreeDiff({ cwd: '/ws' });
    expect(result.source).toBe('working');
    expect(result.isEmpty).toBe(false);
    expect(result.wasTruncated).toBe(false);
    expect(result.diff).toContain('+added');
    expect(result.error).toBeUndefined();
  });

  it('falls back to staged diff when the working tree is clean', async () => {
    installExec({
      'git diff HEAD': '',
      'git diff --cached': 'diff --git a/y b/y\n+staged-change\n',
    });
    const result = await fetchWorkingTreeDiff({ cwd: '/ws' });
    expect(result.source).toBe('staged');
    expect(result.isEmpty).toBe(false);
    expect(result.diff).toContain('+staged-change');
  });

  it('returns isEmpty=true when both working-tree and staged diffs are empty', async () => {
    installExec({ 'git diff HEAD': '', 'git diff --cached': '' });
    const result = await fetchWorkingTreeDiff({ cwd: '/ws' });
    expect(result.isEmpty).toBe(true);
    expect(result.source).toBe('none');
    expect(result.diff).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('surfaces an error string when the working-tree git call fails (not a repo, etc.)', async () => {
    installExec({ 'git diff HEAD': '' }, new Set(['git diff HEAD']));
    const result = await fetchWorkingTreeDiff({ cwd: '/not-a-repo' });
    expect(result.error).toMatch(/simulated failure/);
    expect(result.isEmpty).toBe(true);
    expect(result.source).toBe('none');
  });

  it('surfaces an error string when the staged fallback fails after working-tree was empty', async () => {
    installExec({ 'git diff HEAD': '', 'git diff --cached': '' }, new Set(['git diff --cached']));
    const result = await fetchWorkingTreeDiff({ cwd: '/ws' });
    expect(result.error).toMatch(/simulated failure/);
  });

  it('truncates oversized diffs to the configured cap and marks wasTruncated', async () => {
    const huge = 'x'.repeat(50_000);
    installExec({ 'git diff HEAD': huge });
    const result = await fetchWorkingTreeDiff({ cwd: '/ws', truncateChars: 5_000 });
    expect(result.wasTruncated).toBe(true);
    expect(result.diff.length).toBe(5_000 + '\n... (diff truncated)'.length);
    expect(result.diff.endsWith('(diff truncated)')).toBe(true);
  });

  it('treats whitespace-only stdout as empty (trims before considering non-empty)', async () => {
    installExec({ 'git diff HEAD': '   \n\n\t\n', 'git diff --cached': '' });
    const result = await fetchWorkingTreeDiff({ cwd: '/ws' });
    expect(result.isEmpty).toBe(true);
  });
});

describe('fetchBranchRangeDiff', () => {
  it('runs `git diff <base>...HEAD` by default and returns the result tagged "range"', async () => {
    installExec({ 'git diff main...HEAD': 'diff --git a/z b/z\n+branch-change\n' });
    const result = await fetchBranchRangeDiff('main', { cwd: '/ws' });
    expect(result.source).toBe('range');
    expect(result.diff).toContain('+branch-change');
  });

  it('uses the caller-supplied head ref when provided', async () => {
    installExec({ 'git diff main...feature-x': 'diff' });
    const result = await fetchBranchRangeDiff('main', { cwd: '/ws', head: 'feature-x' });
    expect(result.source).toBe('range');
    const execMock = exec as unknown as ReturnType<typeof vi.fn>;
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).toBe('git diff main...feature-x');
  });

  it('returns an empty result when the branch range has no changes', async () => {
    installExec({ 'git diff main...HEAD': '' });
    const result = await fetchBranchRangeDiff('main', { cwd: '/ws' });
    expect(result.isEmpty).toBe(true);
    expect(result.source).toBe('none');
  });

  it('rejects an empty base ref with an explanatory error', async () => {
    const result = await fetchBranchRangeDiff('', { cwd: '/ws' });
    expect(result.error).toMatch(/base is required/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts legal git ref characters including slashes and @/~/^ selectors', async () => {
    installExec({ 'git diff origin/main~1...HEAD@{1}': 'diff' });
    const result = await fetchBranchRangeDiff('origin/main~1', { cwd: '/ws', head: 'HEAD@{1}' });
    expect(result.source).toBe('range');
  });

  it('strips shell metacharacters from ref names (injection guard)', async () => {
    // A ref with ';' should not escape the exec invocation. The primitive
    // substitutes the entire ref with empty string, so git fails cleanly
    // with "ambiguous argument" instead of running the injected command.
    installExec({ 'git diff ...HEAD': '' }, new Set(['git diff ...HEAD']));
    const result = await fetchBranchRangeDiff('main; rm -rf /', { cwd: '/ws' });
    // The error path is taken because the mock is set to fail that command.
    expect(result.error).toBeDefined();
    // The injected payload never appears in the exec call.
    const execMock = exec as unknown as ReturnType<typeof vi.fn>;
    const cmd = execMock.mock.calls[0][0] as string;
    expect(cmd).not.toContain('rm -rf');
  });

  it('surfaces an error string when the underlying git call fails', async () => {
    installExec({ 'git diff main...HEAD': '' }, new Set(['git diff main...HEAD']));
    const result = await fetchBranchRangeDiff('main', { cwd: '/ws' });
    expect(result.error).toMatch(/simulated failure/);
  });
});
