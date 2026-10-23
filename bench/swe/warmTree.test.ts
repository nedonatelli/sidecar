import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { warmWorkingTree, warmLogLine, WARM_PATTERN } from './warmTree.js';
import { grepArgs } from '../../src/agent/tools/grepArgs.js';

const exit =
  (status: number, stderr = '') =>
  () => {
    throw Object.assign(new Error(`exit ${status}`), { status, stderr: Buffer.from(stderr) });
  };

describe('warmWorkingTree', () => {
  it("runs the grep tool's own invocation over the whole tree", () => {
    // Mirroring the tool is the point: the warm-up must touch the files the
    // agent's first search will, or that search still pays the first-read cost.
    const calls: { args: string[]; cwd: string }[] = [];
    warmWorkingTree('/repo', (args, cwd) => {
      calls.push({ args, cwd });
    });
    expect(calls).toEqual([{ args: grepArgs(WARM_PATTERN, '.'), cwd: '/repo' }]);
  });

  it('treats exit 1 (no match) as a full warm -- the expected outcome', () => {
    const w = warmWorkingTree('/repo', exit(1));
    expect(w.outcome).toBe('full');
    expect(w.reason).toBeUndefined();
    expect(w.ms).toBeGreaterThanOrEqual(0);
  });

  // The agent's grep tool shows exit 2 as a successful partial search, so the
  // warm-up reported a failure while every later search worked.
  it('reports exit 2 as warmed-with-errors, with the reason grep gave', () => {
    const w = warmWorkingTree(
      '/repo',
      exit(2, 'grep: ./locked.py: Permission denied\ngrep: ./dangling: No such file or directory\n'),
    );
    expect(w.outcome).toBe('with-errors');
    expect(w.reason).toBe('exit 2: grep: ./locked.py: Permission denied (+1 more)');
    expect(warmLogLine('django/django', w)).toContain('warmed django/django working tree');
    expect(warmLogLine('django/django', w)).toContain('Permission denied');
  });

  it('does not retry an exit status: it is grep answering', () => {
    let calls = 0;
    const w = warmWorkingTree('/repo', () => {
      calls++;
      exit(2)();
    });
    expect(calls).toBe(1);
    expect(w.outcome).toBe('with-errors');
  });

  it('reports a spawn failure with its code, and never throws', () => {
    const w = warmWorkingTree('/repo', () => {
      throw Object.assign(new Error('spawnSync grep ENOENT'), { code: 'ENOENT', status: null });
    });
    expect(w.outcome).toBe('failed');
    expect(w.reason).toContain('ENOENT');
    expect(warmLogLine('django/django', w)).toMatch(/FAILED .*ENOENT.*cold-read cost/);
  });

  it('retries a failure without an exit status once, and says so when the retry works', () => {
    let calls = 0;
    const w = warmWorkingTree('/repo', () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('spawnSync grep EAGAIN'), { code: 'EAGAIN', status: null });
      exit(1)();
    });
    expect(calls).toBe(2);
    expect(w.outcome).toBe('full');
    expect(w.reason).toContain('first attempt failed: EAGAIN');
  });

  it('names a kill by its signal', () => {
    const w = warmWorkingTree('/repo', () => {
      throw Object.assign(new Error('killed'), { status: null, signal: 'SIGTERM' });
    });
    expect(w.outcome).toBe('failed');
    expect(w.reason).toContain('signal SIGTERM');
  });

  it('really reads a tree with the real grep, and the pattern never matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-tree-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
      expect(warmWorkingTree(dir).outcome).toBe('full');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
