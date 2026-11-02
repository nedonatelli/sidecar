import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'node:child_process';
import { failedRemovals, removeCleanFailures } from './cleanFailures.js';

const ERR = [
  'Command failed: git clean -fdxq',
  'warning: failed to remove nul: Permission denied',
  'warning: failed to remove sympy/sets/handlers/__pycache__/: Directory not empty',
  '',
].join('\n');

let dir: string;
afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

describe('failedRemovals', () => {
  it('reads each path git could not remove', () => {
    expect(failedRemovals(ERR)).toEqual(['nul', 'sympy/sets/handlers/__pycache__']);
  });

  it('finds nothing in an unrelated error', () => {
    expect(failedRemovals('Command failed: git clean -fdxq\nfatal: not a git repository')).toEqual([]);
  });
});

describe('removeCleanFailures', () => {
  it('removes the named paths and never leaves the repo', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-clean-'));
    fs.mkdirSync(path.join(dir, 'a/__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/__pycache__/x.pyc'), '');
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    fs.writeFileSync(outside, '');
    try {
      const err = [
        'warning: failed to remove a/__pycache__/: Directory not empty',
        `warning: failed to remove ../${path.basename(outside)}: Permission denied`,
      ].join('\n');
      expect(removeCleanFailures(dir, err)).toEqual(['a/__pycache__']);
      expect(fs.existsSync(path.join(dir, 'a/__pycache__'))).toBe(false);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  // The #395 case end to end: Git Bash's `2>nul` makes a file git clean cannot remove.
  const bash = 'C:/Program Files/Git/bin/bash.exe';
  it.skipIf(process.platform !== 'win32' || !fs.existsSync(bash))(
    'lets git clean succeed after a Git Bash `2>nul`',
    () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-clean-nul-'));
      execFileSync('git', ['init', '-q', dir]);
      spawnSync(bash, ['-c', 'ls no_such_file 2>nul'], { cwd: dir });
      expect(fs.readdirSync(dir)).toContain('nul');
      const first = spawnSync('git', ['clean', '-fdxq'], { cwd: dir, encoding: 'utf-8' });
      expect(first.status).not.toBe(0);
      expect(removeCleanFailures(dir, first.stderr)).toEqual(['nul']);
      expect(spawnSync('git', ['clean', '-fdxq'], { cwd: dir }).status).toBe(0);
    },
    30_000,
  );
});
