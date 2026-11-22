import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hideHistoryPastBase, KEEP_UNREACHABLE_CONFIG, type GitRunner } from './hideFutureHistory.js';

// Real repositories, because the leak was git's own behavior: a hard reset
// moves HEAD and leaves every other ref, and the commits they reach, in place.
// GIT_DIR / GIT_INDEX_FILE are dropped for the same reason as in
// captureDiff.test.ts: inside the pre-commit hook they would point these
// commands at the repository being committed.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'].includes(k)),
);
const run: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).toString();

let root: string;
let upstream: string;
let clone: string;
let base: string;
let fix: string;

function commit(dir: string, file: string, text: string, message: string): string {
  fs.writeFileSync(path.join(dir, file), text);
  run(['add', '-A'], dir);
  run(['commit', '-qm', message], dir);
  return run(['rev-parse', 'HEAD'], dir).trim();
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-history-'));
  upstream = path.join(root, 'upstream');
  fs.mkdirSync(upstream);
  run(['init', '-q', '-b', 'main'], upstream);
  run(['config', 'user.email', 't@t'], upstream);
  run(['config', 'user.name', 't'], upstream);
  run(['config', 'core.autocrlf', 'false'], upstream);
  base = commit(upstream, 'http.py', 'if year < 70:\n    year += 2000\n', 'base');
  fix = commit(upstream, 'http.py', 'year = current_century(year)\n', 'Fixed #30479 -- two-digit years');
  run(['tag', 'v3.0'], upstream);
  run(['branch', 'stable/3.0.x'], upstream);

  // The harness's state: a clone of upstream, hard-reset to the task's base.
  clone = path.join(root, 'clone');
  // autocrlf off in the clone too: Git for Windows would check http.py out with CRLF.
  run(['clone', '-q', '-c', 'core.autocrlf=false', upstream, clone], root);
  run(['fetch', '-q', 'origin', 'main'], clone); // leaves FETCH_HEAD naming the fix
  run(['reset', '--hard', '-q', base], clone);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hideHistoryPastBase (#507)', () => {
  it('a hard reset alone leaves the fix one `git log --all` away (the leak)', () => {
    expect(run(['log', '--all', '--format=%H'], clone)).toContain(fix);
  });

  it('leaves only the base reachable: no branch, tag, remote ref, reflog or FETCH_HEAD leads to the fix', () => {
    hideHistoryPastBase(clone, base, run);

    expect(lines(run(['log', '--all', '--format=%H'], clone))).toEqual([base]);
    expect(lines(run(['rev-list', '--all', '--reflog'], clone))).toEqual([base]);
    expect(run(['log', '--all', '--grep=30479', '--format=%H'], clone).trim()).toBe('');
    expect(run(['for-each-ref'], clone).trim()).toBe('');
    expect(run(['tag', '--list'], clone).trim()).toBe('');
    expect(run(['branch', '-a'], clone)).not.toContain('stable/3.0.x');
    expect(fs.existsSync(path.join(clone, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(fs.existsSync(path.join(clone, '.git', 'ORIG_HEAD'))).toBe(false);
    expect(run(['rev-parse', 'HEAD'], clone).trim()).toBe(base);
  });

  it('keeps the later commits in the object store, so the next task on the shared clone can reset to one', () => {
    hideHistoryPastBase(clone, base, run);
    for (const [key, value] of KEEP_UNREACHABLE_CONFIG) {
      expect(run(['config', '--get', key], clone).trim()).toBe(value);
    }

    // The next task's base is the later commit: reset, then hide again.
    run(['reset', '--hard', '-q', fix], clone);
    hideHistoryPastBase(clone, fix, run);
    expect(lines(run(['log', '--all', '--format=%H'], clone))).toEqual([fix, base]);
    expect(fs.readFileSync(path.join(clone, 'http.py'), 'utf8')).toBe('year = current_century(year)\n');
  });

  it('keeps the origin remote, which a blobless clone needs for lazy blob fetches', () => {
    hideHistoryPastBase(clone, base, run);
    expect(lines(run(['remote'], clone))).toEqual(['origin']);
  });

  it('refuses a clone whose HEAD is not the base', () => {
    expect(() => hideHistoryPastBase(clone, 'f'.repeat(40), run)).toThrow();
  });
});
