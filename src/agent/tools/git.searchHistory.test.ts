import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { gitSearchHistory } from './git.js';

// Against real git: a blobless clone (`--filter=blob:none`, as the SWE harness
// clones) has no file contents in its history, so pickaxe (`log -S`) needs them
// fetched. Unbounded, that fetch held a run for 43 minutes on Django. The
// search must refuse to fetch and say so, while the message search still works.
describe('gitSearchHistory on a partial clone (real git)', () => {
  let dir: string;
  let clone: string;
  const saved: Record<string, string | undefined> = {};
  const hookVars = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'];

  beforeAll(() => {
    // A pre-commit hook exports these; they would point git at this checkout.
    for (const k of hookVars) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-gsh-'));
    const src = path.join(dir, 'src');
    clone = path.join(dir, 'clone');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    fs.mkdirSync(src);
    git(src, 'init', '-q');
    git(src, 'config', 'user.email', 't@example.com');
    git(src, 'config', 'user.name', 't');
    git(src, 'config', 'core.autocrlf', 'false');
    git(src, 'config', 'uploadpack.allowFilter', 'true');
    for (const i of [1, 2, 3]) {
      fs.writeFileSync(path.join(src, 'f.txt'), `v${i} needle${i}\n`);
      git(src, 'add', 'f.txt');
      git(src, 'commit', '-qm', `change needle ${i}`);
    }
    git(dir, 'clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(src).href, clone);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of hookVars) if (saved[k] !== undefined) process.env[k] = saved[k];
  });

  it('reports content search unavailable and still returns message matches', async () => {
    const result = await gitSearchHistory({ query: 'needle' }, { cwd: clone });
    expect(result).toMatch(/Found 3 commits/);
    expect(result).toContain('[matched via: message]');
    expect(result).toMatch(/Content search \(pickaxe\) is unavailable: this repository is a partial clone/);
  });

  it('fails a content-only search with the reason instead of "No commits found"', async () => {
    await expect(gitSearchHistory({ query: 'needle1', search_type: 'content' }, { cwd: clone })).rejects.toThrow(
      /partial clone/,
    );
  });

  it('fetched nothing: the history blobs are still missing afterwards', () => {
    const missing = execFileSync('git', ['rev-list', '--objects', '--all', '--missing=print'], {
      cwd: clone,
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .filter((l) => l.startsWith('?'));
    expect(missing.length).toBeGreaterThan(0);
  });
});
