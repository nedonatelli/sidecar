import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitEnvForCwd, workingTreeSignature } from './treeSignature.js';

// #247: the signature the loop takes around a shell command, against a real
// git repository, so `git status` behaves as it does for a run.
describe('workingTreeSignature (#247)', () => {
  let repo: string;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: gitEnvForCwd() });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-tree-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'core.autocrlf', 'false');
    write('.gitignore', '__pycache__/\n*.log\n');
    write('src/a.py', 'x = 1\n');
    git('add', '.');
    git('commit', '-qm', 'init');
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('changes when a tracked file is modified (sed -i)', async () => {
    const before = await workingTreeSignature(repo);
    write('src/a.py', 'x = 2\n');
    expect(await workingTreeSignature(repo)).not.toBe(before);
  });

  it('changes when an already-modified file is modified again', async () => {
    write('src/a.py', 'x = 2\n');
    const before = await workingTreeSignature(repo);
    // Same `M` status both times; only the size/mtime part tells them apart.
    write('src/a.py', 'x = 3333\n');
    expect(await workingTreeSignature(repo)).not.toBe(before);
  });

  it('changes when a tracked file is overwritten (cat > existing)', async () => {
    const before = await workingTreeSignature(repo);
    write('src/a.py', 'rewritten = True\n');
    expect(await workingTreeSignature(repo)).not.toBe(before);
  });

  it('does NOT change for a new untracked file, such as a repro script', async () => {
    // 31b django-12125 wrote only `reproduce_issue.py` by shell; counting it
    // turned #222's nudge back into a stop.
    const before = await workingTreeSignature(repo);
    write('reproduce_issue.py', 'import django\n');
    expect(await workingTreeSignature(repo)).toBe(before);
  });

  it('changes when a tracked file is deleted', async () => {
    const before = await workingTreeSignature(repo);
    fs.rmSync(path.join(repo, 'src/a.py'));
    expect(await workingTreeSignature(repo)).not.toBe(before);
  });

  it('does not change for reads, ignored output, or files outside the repo', async () => {
    const before = await workingTreeSignature(repo);
    fs.readFileSync(path.join(repo, 'src/a.py'));
    write('src/__pycache__/a.cpython-312.pyc', 'bytecode');
    write('pytest.log', 'ran');
    fs.writeFileSync(path.join(os.tmpdir(), `sidecar-tree-outside-${process.pid}.txt`), 'temp');
    expect(await workingTreeSignature(repo)).toBe(before);
    fs.rmSync(path.join(os.tmpdir(), `sidecar-tree-outside-${process.pid}.txt`), { force: true });
  });

  it('is null outside a git repository, and for no root', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-plain-'));
    try {
      expect(await workingTreeSignature(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
    expect(await workingTreeSignature(undefined)).toBeNull();
  });

  it('reads the repository at the root even when a hook exported GIT_DIR / GIT_INDEX_FILE', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-other-'));
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
    try {
      process.env.GIT_DIR = path.join(other, 'not-a-repo');
      process.env.GIT_INDEX_FILE = path.join(other, 'index');
      const before = await workingTreeSignature(repo);
      expect(before).not.toBeNull();
      write('src/a.py', 'x = 2\n');
      expect(await workingTreeSignature(repo)).not.toBe(before);
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved.index;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
