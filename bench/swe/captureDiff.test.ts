import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureDiff, snapshotShellWorkspace } from './captureDiff.js';

// A real repository: the bug was git's own behaviour (`git add -A -- <paths>`
// exits 128 on one bad pathspec and stages nothing), so a mock would prove
// nothing.
let dir: string;
let base: string;
// Inside a git hook (the pre-commit run of this suite) git exports GIT_DIR and
// GIT_INDEX_FILE. Inherited, they point every `git` below at the repository
// being committed instead of this temp one: `git add -A` here staged the temp
// files into the real index, and a parallel test listing `git ls-files src`
// found nothing. `cwd` must decide the repository, so they are dropped.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(k)),
);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).toString();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-diff-'));
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'core.autocrlf', 'false');
  write('pkg/mod.py', 'x = 1\n');
  write('pkg/gone.py', 'y = 2\n');
  write('.gitignore', 'pkg/_version.py\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD').trim();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('captureDiff', () => {
  // #1 of the ticket: astropy-14365 -- a refused absolute write_file path sat in
  // touchedPaths beside the real fix, and the whole patch came back empty.
  it('keeps the valid edit when another touched path is outside the repo', () => {
    write('pkg/mod.py', 'x = 2\n');
    const outside = path.join(os.tmpdir(), 'test_lowercase_qdp.py');
    const { patch, dropped } = captureDiff(dir, base, ['pkg/mod.py', outside, '../escape.py']);
    expect(patch).toContain('-x = 1');
    expect(patch).toContain('+x = 2');
    expect(dropped).toEqual([
      { path: outside, reason: 'outside-repo' },
      { path: '../escape.py', reason: 'outside-repo' },
    ]);
  });

  // #2 of the ticket: astropy-12907 -- scratch tests written, then `rm`'d by a
  // shell command, still in touchedPaths.
  it('keeps the valid edit when a scratch file was written and later removed', () => {
    write('pkg/mod.py', 'x = 2\n');
    write('test_bug.py', 'assert False\n');
    fs.rmSync(path.join(dir, 'test_bug.py'));
    const { patch, dropped } = captureDiff(dir, base, ['test_bug.py', 'pkg/mod.py']);
    expect(patch).toContain('+x = 2');
    expect(dropped).toEqual([{ path: 'test_bug.py', reason: 'missing-untracked' }]);
  });

  // #195's first acceptance criterion, as one case: both triggers in one run.
  it('captures the valid edit alongside an outside path and a removed scratch file (#195)', () => {
    write('pkg/mod.py', 'x = 2\n');
    write('test_fix.py', 'assert True\n');
    fs.rmSync(path.join(dir, 'test_fix.py'));
    const outside = path.join(os.tmpdir(), 'test_lowercase_qdp.py');
    const { patch, dropped } = captureDiff(dir, base, [outside, 'test_fix.py', 'pkg/mod.py']);
    expect(patch).toContain('-x = 1');
    expect(patch).toContain('+x = 2');
    expect(dropped.map((d) => d.reason).sort()).toEqual(['missing-untracked', 'outside-repo']);
  });

  it('shows a tracked file the agent deleted as a deletion', () => {
    fs.rmSync(path.join(dir, 'pkg/gone.py'));
    const { patch, dropped } = captureDiff(dir, base, ['pkg/gone.py']);
    expect(patch).toContain('deleted file mode');
    expect(patch).toContain('-y = 2');
    expect(dropped).toEqual([]);
  });

  // matplotlib-18869: the only edit was to an untracked, gitignored generated file.
  it('drops an untracked ignored file instead of failing the add', () => {
    write('pkg/_version.py', 'v = 1\n');
    write('pkg/mod.py', 'x = 2\n');
    const { patch, dropped } = captureDiff(dir, base, ['pkg/_version.py', 'pkg/mod.py']);
    expect(patch).toContain('+x = 2');
    expect(patch).not.toContain('_version');
    expect(dropped).toEqual([{ path: 'pkg/_version.py', reason: 'ignored' }]);
  });

  it('includes a new untracked file the agent kept', () => {
    write('pkg/new.py', 'z = 3\n');
    expect(captureDiff(dir, base, ['pkg/new.py']).patch).toContain('+z = 3');
  });

  it('still captures a committed fix, and still ignores unrelated drift', () => {
    write('pkg/mod.py', 'x = 2\n');
    git('commit', '-qam', 'agent committed');
    write('pkg/gone.py', 'drift\n');
    const { patch } = captureDiff(dir, base, ['pkg/mod.py']);
    expect(patch).toContain('+x = 2');
    expect(patch).not.toContain('drift');
  });

  it('returns an empty patch for edited-then-reverted files and when nothing survives', () => {
    write('pkg/mod.py', 'x = 2\n');
    write('pkg/mod.py', 'x = 1\n');
    expect(captureDiff(dir, base, ['pkg/mod.py']).patch).toBe('');
    expect(captureDiff(dir, base, ['/tmp/a.py', 'never-written.py'])).toEqual({
      patch: '',
      dropped: [
        { path: '/tmp/a.py', reason: 'outside-repo' },
        { path: 'never-written.py', reason: 'missing-untracked' },
      ],
    });
  });

  it('accepts backslash and absolute in-repo spellings of a path', () => {
    write('pkg/mod.py', 'x = 2\n');
    const { patch } = captureDiff(dir, base, [path.join(dir, 'pkg', 'mod.py')]);
    expect(patch).toContain('+x = 2');
  });

  it('keeps legacy patch bytes when only a file-tool path changed', () => {
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');
    git('add', '-A', '--', 'pkg/mod.py');
    const legacyPatch = git('diff', '--cached', base, '--', 'pkg/mod.py');
    git('reset', '--quiet', '--', 'pkg/mod.py');

    const result = captureDiff(dir, base, ['pkg/mod.py'], snapshot);

    expect(result.patch).toBe(legacyPatch);
    expect(result.shellChanged).toBeUndefined();
    expect(result.drift).toBeUndefined();
  });

  it('keeps the file-tool capture exactly when no snapshot is passed (shell capture off)', () => {
    write('pkg/mod.py', 'x = 2\n');
    write('pkg/from-shell.py', 'shell edit\n');
    git('add', '--', 'pkg/mod.py');
    const legacyPatch = git('diff', '--cached', base, '--', 'pkg/mod.py');
    git('reset', '--quiet', '--', 'pkg/mod.py');

    const result = captureDiff(dir, base, ['pkg/mod.py']);

    expect(result).toEqual({ patch: legacyPatch, dropped: [] });
    expect(result.patch).not.toContain('from-shell.py');
  });

  it('captures tracked edits, deletions, and non-ignored new files from shell activity', () => {
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');
    fs.rmSync(path.join(dir, 'pkg/gone.py'));
    write('pkg/new.py', 'z = 3\n');
    write('pkg/_version.py', 'v = 1\n');

    expect(captureDiff(dir, base, []).patch).toBe('');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.shellChanged).toEqual(['pkg/gone.py', 'pkg/mod.py', 'pkg/new.py']);
    expect(result.patch).toContain('pkg/mod.py');
    expect(result.patch).toContain('pkg/gone.py');
    expect(result.patch).toContain('pkg/new.py');
    expect(result.patch).not.toContain('_version.py');
    expect(result.drift).toBeUndefined();
  });

  it('does not report explicit file-tool paths as shell changes', () => {
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');

    const result = captureDiff(dir, base, [path.join(dir, 'pkg/mod.py')], snapshot);

    expect(result.patch).toContain('+x = 2');
    expect(result.shellChanged).toBeUndefined();
  });

  it('keeps shell paths out when tracked files changed before the snapshot', () => {
    write('pkg/mod.py', 'environment changed a tracked file\n');
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/from-shell.py', 'during the run\n');
    write('pkg/gone.py', 'during the run\n');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.drift).toEqual({ reason: 'dirty-at-start', pathCount: 1 });
    expect(result.patch).toBe('');
    expect(result.patch).not.toContain('environment changed');
    expect(result.patch).not.toContain('from-shell.py');
  });

  it('ignores setup-created untracked files while capturing later shell changes', () => {
    write('pkg/build.egg-info/PKG-INFO', 'generated by environment setup\n');
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');
    write('pkg/new.py', 'z = 3\n');
    write('pkg/build.egg-info/repro.py', 'shell-created scratch file\n');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.shellChanged).toEqual(['pkg/build.egg-info/repro.py', 'pkg/mod.py', 'pkg/new.py']);
    expect(result.patch).toContain('+x = 2');
    expect(result.patch).toContain('+z = 3');
    expect(result.patch).toContain('shell-created scratch file');
    expect(result.patch).not.toContain('generated by environment setup');
    expect(result.drift).toBeUndefined();
  });

  it('suppresses shell capture when background processes did not stop', () => {
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');
    write('pkg/from-shell.py', 'shell edit\n');

    const result = captureDiff(dir, base, ['pkg/mod.py'], snapshot, false);

    expect(result.patch).toContain('+x = 2');
    expect(result.patch).not.toContain('from-shell.py');
    expect(result.shellChanged).toBeUndefined();
    expect(result.drift).toEqual({ reason: 'process-still-running', pathCount: 0 });
  });

  it('keeps a different checked-out commit out of the patch', () => {
    const snapshot = snapshotShellWorkspace(dir);
    git('checkout', '--quiet', '--orphan', 'drift');
    git('rm', '-rf', '.');
    write('other.py', 'unrelated branch\n');
    git('add', '-A');
    git('commit', '-qm', 'drift');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.patch).toBe('');
    expect(result.drift).toEqual({ reason: 'head-diverged', pathCount: 0 });
  });

  it('captures a shell change committed on top of the task baseline', () => {
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');
    git('add', 'pkg/mod.py');
    git('commit', '-qm', 'shell edit');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.patch).toContain('+x = 2');
    expect(result.shellChanged).toEqual(['pkg/mod.py']);
    expect(result.drift).toBeUndefined();
  });

  it('keeps explicit file-tool paths when the snapshot is unavailable or mismatched', () => {
    const snapshot = snapshotShellWorkspace(dir);
    write('pkg/mod.py', 'x = 2\n');
    write('pkg/from-shell.py', 'shell edit\n');

    const unavailable = captureDiff(dir, base, ['pkg/mod.py'], null);
    expect(unavailable.patch).toContain('+x = 2');
    expect(unavailable.patch).not.toContain('from-shell.py');
    expect(unavailable.shellChanged).toBeUndefined();
    expect(unavailable.drift).toEqual({ reason: 'snapshot-unavailable', pathCount: 0 });

    const mismatched = captureDiff(dir, base, ['pkg/mod.py'], { ...snapshot, head: 'other-commit' });
    expect(mismatched.patch).toContain('+x = 2');
    expect(mismatched.patch).not.toContain('from-shell.py');
    expect(mismatched.shellChanged).toBeUndefined();
    expect(mismatched.drift).toEqual({ reason: 'baseline-mismatch', pathCount: 0 });
  });

  it('suppresses automatic capture when more than 100 paths changed', () => {
    const snapshot = snapshotShellWorkspace(dir);
    for (let i = 0; i < 101; i++) write(`new-${i}.py`, 'new\n');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.patch).toBe('');
    expect(result.shellChanged).toBeUndefined();
    expect(result.drift).toEqual({ reason: 'too-many-paths', pathCount: 101 });
  });

  it('marks changes across most of a tracked tree as drift', () => {
    for (let i = 0; i < 17; i++) write(`src/file-${i}.py`, 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'expand base');
    base = git('rev-parse', 'HEAD').trim();
    const snapshot = snapshotShellWorkspace(dir);
    for (let i = 0; i < 11; i++) write(`src/file-${i}.py`, 'changed\n');

    const result = captureDiff(dir, base, [], snapshot);

    expect(result.patch).toBe('');
    expect(result.shellChanged).toBeUndefined();
    expect(result.drift).toEqual({
      reason: 'widespread-change',
      pathCount: 11,
      trackedPathCount: 11,
      baseTrackedPathCount: 20,
    });
  });
});
