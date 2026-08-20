import { describe, it, expect } from 'vitest';
import { scored, compareArms, fisherExactP, trialsNeeded, type ArmResult } from './guards.js';

const arm = (name: string, outcomes: ArmResult['outcomes'], expected = outcomes.length): ArmResult => ({
  arm: name,
  outcomes,
  expectedTrials: expected,
});

describe('scored', () => {
  it('excludes timeouts from the denominator but keeps them visible', () => {
    const s = scored(arm('full', ['PASS', 'PASS', 'TIMEOUT']));
    expect(s).toMatchObject({ passed: 2, scored: 2, timeouts: 1, valid: true });
  });

  it('marks an arm invalid when fewer trials were recorded than requested', () => {
    // The live failure: a case timed out and vitest killed the test before the
    // third trial ran, so the arm reported 2 results for a 3-trial request.
    expect(scored(arm('full', ['PASS', 'PASS'], 3)).valid).toBe(false);
  });
});

describe('compareArms', () => {
  it('refuses to compare when a denominator is short', () => {
    const c = compareArms(arm('full', ['PASS', 'PASS'], 3), arm('bare', ['FAIL', 'FAIL', 'FAIL']));
    expect(c.conclusive).toBe(false);
    expect(c.summary).toMatch(/INVALID/);
  });

  it('calls 2/3 vs 0/3 inconclusive — the exact read that misled us', () => {
    const c = compareArms(arm('full', ['PASS', 'PASS', 'FAIL']), arm('bare', ['FAIL', 'FAIL', 'FAIL']));
    expect(c.conclusive).toBe(false);
    expect(c.summary).toMatch(/INCONCLUSIVE/);
  });

  it('calls the large under-specified gap conclusive', () => {
    // bare 2/9 vs full 7/9 — the one comparison that survived the evening.
    const bare = arm('bare', ['PASS', 'PASS', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
    const full = arm('full', ['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'FAIL', 'FAIL']);
    const c = compareArms(bare, full);
    expect(c.conclusive).toBe(true);
    expect(c.summary).toMatch(/CONCLUSIVE/);
  });

  it('reports timeouts alongside the verdict instead of hiding them', () => {
    const c = compareArms(arm('a', ['PASS', 'PASS', 'TIMEOUT']), arm('b', ['PASS', 'PASS', 'PASS']));
    expect(c.summary).toMatch(/1 timeout\(s\) excluded/);
  });
});

describe('fisherExactP', () => {
  it('is symmetric and bounded', () => {
    expect(fisherExactP(3, 0, 0, 3)).toBeCloseTo(fisherExactP(0, 3, 3, 0), 10);
    expect(fisherExactP(2, 1, 1, 2)).toBeLessThanOrEqual(1);
  });

  it('gives an identical split a p-value of 1', () => {
    expect(fisherExactP(2, 1, 2, 1)).toBeCloseTo(1, 10);
  });
});

describe('trialsNeeded', () => {
  it('shows n=3 cannot resolve a 2/3-vs-0/3 sized effect', () => {
    expect(trialsNeeded(0.67, 0)).toBeGreaterThan(3);
  });

  it('needs fewer trials for a larger effect', () => {
    expect(trialsNeeded(1, 0)).toBeLessThan(trialsNeeded(0.7, 0.4));
  });
});
