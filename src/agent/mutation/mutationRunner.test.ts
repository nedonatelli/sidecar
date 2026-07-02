import { describe, it, expect } from 'vitest';
import { runMutationTest, type MutationIo } from './mutationRunner.js';
import { scoreMutants, formatMutationScore, type MutantResult } from './mutationScore.js';
import type { Mutant } from './mutationOperators.js';

/**
 * Fake IO backed by an in-memory file + a `testFn` that decides pass/fail from
 * the current file content — this models a real test suite: a GOOD suite fails
 * (kills) on a mutated file, a WEAK suite keeps passing (mutant survives).
 */
function fakeIo(
  initial: string,
  testFn: (content: string) => { passed: boolean; output: string },
): MutationIo & { current(): string } {
  let content = initial;
  return {
    current: () => content,
    async read() {
      return content;
    },
    async write(_p, c) {
      content = c;
    },
    async runTest() {
      return testFn(content);
    },
  };
}

const ORIGINAL = 'def below(a, b):\n    return a < b\n';

describe('runMutationTest', () => {
  it('voids the run when the baseline test does not pass', async () => {
    const io = fakeIo(ORIGINAL, () => ({ passed: false, output: 'baseline red' }));
    const res = await runMutationTest('m.py', io, { operators: ['relational'] });
    expect(res.baselinePassed).toBe(false);
    expect(res.results).toHaveLength(0);
    expect(res.score.score).toBe(0);
  });

  it('a STRONG suite kills every mutant (score 1.0)', async () => {
    // Strong suite: passes only on the exact original, fails on any mutation.
    const io = fakeIo(ORIGINAL, (c) => ({ passed: c === ORIGINAL, output: c === ORIGINAL ? '' : 'assertion failed' }));
    const res = await runMutationTest('m.py', io, { operators: ['relational'] });
    expect(res.baselinePassed).toBe(true);
    expect(res.score.viable).toBeGreaterThan(0);
    expect(res.score.score).toBe(1);
    expect(res.score.survived).toBe(0);
  });

  it('a WEAK suite lets mutants survive and surfaces them (score 0)', async () => {
    // Weak suite: always green regardless of content — catches nothing.
    const io = fakeIo(ORIGINAL, () => ({ passed: true, output: '' }));
    const res = await runMutationTest('m.py', io, { operators: ['relational'] });
    expect(res.score.killed).toBe(0);
    expect(res.score.survived).toBeGreaterThan(0);
    expect(res.score.score).toBe(0);
    expect(res.score.survivors.length).toBe(res.score.survived);
    expect(res.score.survivors[0].outcome).toBe('survived');
  });

  it('ALWAYS restores the original file after the run', async () => {
    const io = fakeIo(ORIGINAL, (c) => ({ passed: c === ORIGINAL, output: '' }));
    await runMutationTest('m.py', io, { operators: ['relational'] });
    expect(io.current()).toBe(ORIGINAL);
  });

  it('restores the original even if a test run throws', async () => {
    let calls = 0;
    const io: MutationIo & { current(): string } = (() => {
      let content = ORIGINAL;
      return {
        current: () => content,
        async read() {
          return content;
        },
        async write(_p: string, c: string) {
          content = c;
        },
        async runTest() {
          calls++;
          if (calls === 1) return { passed: true, output: '' }; // baseline green
          throw new Error('runner exploded');
        },
      };
    })();
    const res = await runMutationTest('m.py', io, { operators: ['relational'] });
    expect(io.current()).toBe(ORIGINAL); // restored despite the throw
    expect(res.results.every((r) => r.outcome === 'error')).toBe(true);
  });
});

describe('scoreMutants + formatMutationScore', () => {
  const mk = (id: string): Mutant => ({
    id,
    operator: 'relational',
    line: 1,
    original: '<',
    replacement: '>=',
    description: id,
    mutatedSource: '',
  });

  it('computes score as killed / (killed + survived), excluding error/no-coverage', () => {
    const results: MutantResult[] = [
      { mutant: mk('a'), outcome: 'killed' },
      { mutant: mk('b'), outcome: 'killed' },
      { mutant: mk('c'), outcome: 'survived' },
      { mutant: mk('d'), outcome: 'error' },
      { mutant: mk('e'), outcome: 'no-coverage' },
    ];
    const s = scoreMutants(results);
    expect(s.viable).toBe(3);
    expect(s.score).toBeCloseTo(2 / 3, 5);
    expect(s.errored).toBe(1);
    expect(s.noCoverage).toBe(1);
    expect(s.survivors).toHaveLength(1);
  });

  it('score is 0 when nothing is viable', () => {
    expect(scoreMutants([{ mutant: mk('a'), outcome: 'error' }]).score).toBe(0);
  });

  it('formats a readable one-liner', () => {
    const s = scoreMutants([
      { mutant: mk('a'), outcome: 'killed' },
      { mutant: mk('b'), outcome: 'survived' },
    ]);
    expect(formatMutationScore(s)).toContain('mutation score 50%');
    expect(formatMutationScore(s)).toContain('1/2 mutants killed');
  });
});
