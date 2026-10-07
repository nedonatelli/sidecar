import { describe, it, expect } from 'vitest';
import { diffLines } from './lineDiff.js';
import { diffStats } from '../edits/unifiedDiff.js';
import { computeHunks } from '../agent/diff.js';

const apply = (ops: ReturnType<typeof diffLines>) => ({
  a: ops.filter((o) => o.type !== 'add').map((o) => o.line),
  b: ops.filter((o) => o.type !== 'del').map((o) => o.line),
});

/** Reference LCS length (small inputs only). */
function lcsLen(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

describe('diffLines', () => {
  it('reconstructs both sides and stays minimal on random inputs', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 30) }, () => String.fromCharCode(97 + Math.floor(rnd() * 4)));
      const b = a.filter(() => rnd() > 0.2).concat(Array.from({ length: Math.floor(rnd() * 5) }, () => 'x'));
      if (rnd() > 0.5) b.reverse();
      const ops = diffLines(a, b);
      expect(apply(ops)).toEqual({ a, b });
      expect(ops.filter((o) => o.type === 'equal').length).toBe(lcsLen(a, b));
    }
  });

  // #122: an O(m*n) table crashed the extension host on a 30k-line file.
  it('diffs a one-line change in a 30,000-line file quickly', () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[15_000] = 'changed';
    const started = Date.now();
    const ops = diffLines(a, b);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ops.filter((o) => o.type !== 'equal')).toEqual([
      { type: 'del', line: 'line 15000' },
      { type: 'add', line: 'changed' },
    ]);
  });

  it('reports a complete rewrite of a huge file as a block replace, without the table', () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `old ${i}`);
    const b = Array.from({ length: 30_000 }, (_, i) => `new ${i}`);
    const started = Date.now();
    const ops = diffLines(a, b);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(apply(ops)).toEqual({ a, b });
  });

  it('counts past 65,535 lines (the old Uint16 table overflowed)', () => {
    const a = Array.from({ length: 70_000 }, (_, i) => `l${i}`);
    const b = [...a.slice(0, 69_000), 'tail'];
    expect(diffStats(a.join('\n'), b.join('\n'))).toEqual({ added: 1, removed: 1000 });
  });

  it('keeps computeHunks fast on a large file', () => {
    const a = Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 100\n', 'line one hundred\n');
    const started = Date.now();
    expect(computeHunks(a, b)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
