import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { sweepStaleShadows, formatSweepResult } from './shadowSweep.js';

/**
 * Tests for `sweepStaleShadows` (v0.62.1 p.3). The sweep needs a real
 * git repo with real worktrees to exercise the worktree-remove code
 * path, so these tests run against an `execFileSync`-initialized tmp
 * repo — same pattern as `shadowWorkspace.test.ts`. That means:
 *   - lint-staged excludes this file (see lint-staged config)
 *   - full CI still runs these; local dev runs them too (they finish in
 *     ~500ms)
 */

function initTmpRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-sweep-'));
  execFileSync('git', ['init'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# Test repo');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root });
  return root;
}

function addShadowWorktree(mainRoot: string, name: string): string {
  const shadowsRoot = path.join(mainRoot, '.sidecar', 'shadows');
  fs.mkdirSync(shadowsRoot, { recursive: true });
  const shadowPath = path.join(shadowsRoot, name);
  execFileSync('git', ['worktree', 'add', '--detach', shadowPath, 'HEAD'], { cwd: mainRoot });
  return shadowPath;
}

describe('sweepStaleShadows', () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    tmp = null;
    vi.restoreAllMocks();
  });

  it('reports nothing on a repo with no shadow worktrees', async () => {
    tmp = initTmpRepo();
    const result = await sweepStaleShadows(tmp);
    expect(result.prunedWorktrees).toEqual([]);
    expect(result.removedDirs).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('leaves a live shadow worktree untouched', async () => {
    tmp = initTmpRepo();
    const shadow = addShadowWorktree(tmp, 'task-live');

    const result = await sweepStaleShadows(tmp);

    expect(result.prunedWorktrees).toEqual([]);
    expect(result.removedDirs).toEqual([]);
    expect(fs.existsSync(shadow)).toBe(true);
  });

  it('prunes a worktree whose directory was deleted out from under git', async () => {
    tmp = initTmpRepo();
    const shadow = addShadowWorktree(tmp, 'task-orphan');
    // Delete the shadow dir but leave the worktree metadata — exactly
    // the "VS Code crashed mid-shadow" failure mode.
    fs.rmSync(shadow, { recursive: true, force: true });

    const result = await sweepStaleShadows(tmp);

    expect(result.prunedWorktrees).toHaveLength(1);
    expect(result.prunedWorktrees[0]).toContain('task-orphan');
    // Git no longer lists the stale worktree after the prune.
    const listOutput = execFileSync('git', ['worktree', 'list'], { cwd: tmp, encoding: 'utf8' });
    expect(listOutput).not.toContain('task-orphan');
  });

  it('removes an orphan directory with no worktree metadata', async () => {
    tmp = initTmpRepo();
    // Hand-craft a dir under .sidecar/shadows/ that's NOT a registered
    // worktree. This simulates a state where metadata got pruned but
    // the directory was left behind.
    const orphanDir = path.join(tmp, '.sidecar', 'shadows', 'task-ghost');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'some-file.txt'), 'leftover');

    const result = await sweepStaleShadows(tmp);

    expect(result.removedDirs).toHaveLength(1);
    expect(result.removedDirs[0]).toContain('task-ghost');
    expect(fs.existsSync(orphanDir)).toBe(false);
  });

  it('leaves non-shadow worktrees (intentional user worktrees) alone', async () => {
    tmp = initTmpRepo();
    // A worktree outside .sidecar/shadows/ must never be touched.
    const externalWorktree = path.join(os.tmpdir(), `sidecar-user-wt-${Date.now()}`);
    try {
      execFileSync('git', ['worktree', 'add', '--detach', externalWorktree, 'HEAD'], { cwd: tmp });
      // Delete the external one to make it "stale" — but sweep should
      // not touch it because it's outside the shadow root.
      fs.rmSync(externalWorktree, { recursive: true, force: true });

      const result = await sweepStaleShadows(tmp);

      expect(result.prunedWorktrees).toEqual([]);
      // Git still knows about the external worktree because we didn't prune it.
      const listOutput = execFileSync('git', ['worktree', 'list'], { cwd: tmp, encoding: 'utf8' });
      expect(listOutput).toContain(externalWorktree.split('/').pop() ?? 'sidecar-user-wt');
    } finally {
      // Clean up the external worktree metadata manually.
      try {
        execFileSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: tmp });
      } catch {
        // Already gone — fine.
      }
    }
  });

  it('does not throw when the path is not a git repo', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-non-repo-'));
    const result = await sweepStaleShadows(tmp);
    // Should register an error but not crash.
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('skips when shadowsRoot directory does not exist', async () => {
    tmp = initTmpRepo();
    // No shadows directory created; nothing to sweep.
    const result = await sweepStaleShadows(tmp);
    expect(result.prunedWorktrees).toEqual([]);
    expect(result.removedDirs).toEqual([]);
  });

  // v0.62.3 — partial sweep failure. A filesystem error on one orphan
  // (locked file, permission denied, etc.) must NOT abort the sweep
  // for everything else; the failure should be captured in `errors`
  // and the loop should continue. Previously tested only the happy
  // path; this pins the "keep going on per-entry failures" contract
  // using a child file locked via chmod 0 — rmSync recursively removing
  // the parent hits the locked entry and throws, which we assert gets
  // captured as an error while the sibling orphan still gets cleaned.
  it('continues sweeping when one orphan directory removal fails', async () => {
    // Skip on non-Unix platforms — chmod 0 only reliably blocks
    // removal on Unix file systems.
    if (process.platform === 'win32') return;

    tmp = initTmpRepo();
    const shadowsRoot = path.join(tmp, '.sidecar', 'shadows');
    fs.mkdirSync(shadowsRoot, { recursive: true });

    const goodOrphan = path.join(shadowsRoot, 'task-good');
    const badOrphan = path.join(shadowsRoot, 'task-bad');
    fs.mkdirSync(goodOrphan);
    fs.mkdirSync(badOrphan);
    fs.writeFileSync(path.join(goodOrphan, 'a.txt'), 'a');
    fs.writeFileSync(path.join(badOrphan, 'b.txt'), 'b');
    // Lock the bad orphan's parent so fs.rmSync can't unlink its
    // contents. chmod 0 on the *directory* means "can't list, can't
    // modify" — rmSync then fails with EACCES even with force:true.
    fs.chmodSync(badOrphan, 0o000);

    try {
      const result = await sweepStaleShadows(tmp);

      // The good orphan got removed…
      expect(result.removedDirs.some((d) => d.includes('task-good'))).toBe(true);
      expect(fs.existsSync(goodOrphan)).toBe(false);
      // …the bad one is reported as an error but didn't crash the sweep.
      expect(result.errors.some((e) => e.path.includes('task-bad'))).toBe(true);
      // Bad orphan is still on disk because the delete threw.
      expect(fs.existsSync(badOrphan)).toBe(true);
    } finally {
      // Restore perms so afterEach cleanup can unlink.
      try {
        fs.chmodSync(badOrphan, 0o755);
      } catch {
        // Best-effort.
      }
    }
  });
});

describe('formatSweepResult', () => {
  it('returns empty string when the result is fully empty', () => {
    expect(formatSweepResult({ prunedWorktrees: [], removedDirs: [], errors: [] })).toBe('');
  });

  it('singularizes "directory" and "worktree"', () => {
    expect(
      formatSweepResult({
        prunedWorktrees: ['/tmp/shadow-a'],
        removedDirs: ['/tmp/shadow-b'],
        errors: [],
      }),
    ).toBe('Shadow sweep: 1 stale worktree, 1 orphan directory');
  });

  it('pluralizes for counts > 1', () => {
    const line = formatSweepResult({
      prunedWorktrees: ['a', 'b'],
      removedDirs: ['c', 'd', 'e'],
      errors: [{ path: 'x', message: 'boom' }],
    });
    expect(line).toBe('Shadow sweep: 2 stale worktrees, 3 orphan directories, 1 error');
  });
});
