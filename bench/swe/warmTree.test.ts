import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { warmWorkingTree, WARM_PATTERN } from './warmTree.js';

describe('warmWorkingTree', () => {
  it("runs the grep tool's own invocation over the whole tree", () => {
    // Mirroring the tool is the point: the warm-up must touch the files the
    // agent's first search will, or that search still pays the first-read cost.
    const calls: { args: string[]; cwd: string }[] = [];
    warmWorkingTree('/repo', (args, cwd) => {
      calls.push({ args, cwd });
    });
    expect(calls).toEqual([{ args: ['-rn', '-E', '--include=*', WARM_PATTERN, '.'], cwd: '/repo' }]);
  });

  it('treats exit 1 (no match) as success -- the expected outcome', () => {
    const ms = warmWorkingTree('/repo', () => {
      throw Object.assign(new Error('exit 1'), { status: 1 });
    });
    expect(ms).not.toBeNull();
  });

  it('returns null rather than throwing on any other failure, so a task is never lost to it', () => {
    const ms = warmWorkingTree('/repo', () => {
      throw Object.assign(new Error('ENOENT'), { status: undefined, code: 'ENOENT' });
    });
    expect(ms).toBeNull();
  });

  it('really reads a tree with the real grep, and the pattern never matches', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-tree-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.py'), 'x = 1\n');
      expect(warmWorkingTree(dir)).not.toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
