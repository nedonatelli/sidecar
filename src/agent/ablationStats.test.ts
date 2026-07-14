import { describe, it, expect } from 'vitest';
import {
  mcnemarExactP,
  wilsonInterval,
  inferAblation,
  expectedDiscordantRate,
  requiredRepsForPower,
  planAblationCampaign,
  MIN_DISCORDANT_FOR_SIGNIFICANCE,
  type Pair,
} from './ablationStats.js';

const pair = (withScaffold: boolean, withoutScaffold: boolean): Pair => ({ withScaffold, withoutScaffold });

/** n pairs the scaffold rescued (b), m it broke (c), plus concordant filler. */
function pairs(b: number, c: number, bothPass = 0, bothFail = 0): Pair[] {
  return [
    ...Array.from({ length: b }, () => pair(true, false)),
    ...Array.from({ length: c }, () => pair(false, true)),
    ...Array.from({ length: bothPass }, () => pair(true, true)),
    ...Array.from({ length: bothFail }, () => pair(false, false)),
  ];
}

describe('mcnemarExactP', () => {
  it('is 1 when nothing is discordant — the arms never disagreed', () => {
    expect(mcnemarExactP(0, 0)).toBe(1);
  });

  it('matches the exact binomial by hand', () => {
    // b=6, c=0 → 2 · P(X ≤ 0 | n=6, p=0.5) = 2 · (1/64) = 0.03125
    expect(mcnemarExactP(6, 0)).toBeCloseTo(0.03125, 6);
    // b=5, c=0 → 2 · (1/32) = 0.0625
    expect(mcnemarExactP(5, 0)).toBeCloseTo(0.0625, 6);
    // b=8, c=1 → 2 · [C(9,0) + C(9,1)] · 0.5^9 = 2 · 10/512 = 0.0390625
    expect(mcnemarExactP(8, 1)).toBeCloseTo(0.0390625, 6);
  });

  it('is symmetric — direction is the caller’s to interpret', () => {
    expect(mcnemarExactP(7, 2)).toBeCloseTo(mcnemarExactP(2, 7), 12);
  });

  it('is 1.0 for an even split, and never exceeds 1', () => {
    expect(mcnemarExactP(5, 5)).toBe(1);
    for (let b = 0; b <= 10; b++) for (let c = 0; c <= 10; c++) expect(mcnemarExactP(b, c)).toBeLessThanOrEqual(1);
  });
});

describe('the honesty gate', () => {
  it('significance at 0.05 is ARITHMETICALLY impossible below the threshold', () => {
    // The property the gate rests on: with fewer than MIN_DISCORDANT pairs, even a
    // clean sweep for the scaffold cannot reach p < 0.05. Reporting a lift there
    // would be reporting noise as a finding.
    for (let n = 1; n < MIN_DISCORDANT_FOR_SIGNIFICANCE; n++) {
      expect(mcnemarExactP(n, 0)).toBeGreaterThanOrEqual(0.05);
    }
    // …and at the threshold it becomes reachable.
    expect(mcnemarExactP(MIN_DISCORDANT_FOR_SIGNIFICANCE, 0)).toBeLessThan(0.05);
  });

  it('calls a clean sweep of 5 UNDERPOWERED, not a win', () => {
    // 5/5 discordant pairs favouring the scaffold LOOKS like a slam dunk and is
    // not: p = 0.0625. This is the exact shape that produced the SWE campaign's
    // n=1 "+100%".
    const r = inferAblation(pairs(5, 0, 20, 20));
    expect(r.verdict).toBe('underpowered');
    expect(r.explanation).toMatch(/arithmetically impossible/i);
    expect(r.explanation).toMatch(/no result/i);
  });

  it('calls 100 pairs with zero disagreement UNDERPOWERED — volume is not power', () => {
    // The SWE campaign's real failure mode: plenty of runs, zero discordant pairs,
    // so the instrument literally cannot see. A big n does not rescue this.
    const r = inferAblation(pairs(0, 0, 50, 50));
    expect(r.pairs).toBe(100);
    expect(r.discordant).toBe(0);
    expect(r.verdict).toBe('underpowered');
  });
});

describe('inferAblation verdicts', () => {
  it('HELPS when the scaffold rescues significantly more than it breaks', () => {
    const r = inferAblation(pairs(9, 1, 30, 10));
    expect(r.verdict).toBe('helps');
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.lift).toBeCloseTo((9 - 1) / 50, 6);
    expect(r.explanation).toMatch(/HELPS/);
  });

  it('HURTS when the scaffold breaks significantly more than it rescues', () => {
    // The verdict that matters most: a scaffold can be a net negative, and the
    // harness must be willing to say so. (The critic ran for months as a blocker.)
    const r = inferAblation(pairs(1, 9, 30, 10));
    expect(r.verdict).toBe('hurts');
    expect(r.lift).toBeLessThan(0);
    expect(r.explanation).toMatch(/HURTS/);
  });

  it('NO-EFFECT when there was power to see one and there was none', () => {
    const r = inferAblation(pairs(6, 6, 20, 20));
    expect(r.verdict).toBe('no-effect');
    expect(r.discordant).toBe(12);
    expect(r.explanation).toMatch(/pure tax/i);
  });

  it('counts the concordant cells but does not let them drive the verdict', () => {
    // Both-pass and both-fail pairs say the case is easy or impossible — they carry
    // no information about the scaffold, and padding them must not manufacture
    // significance.
    const few = inferAblation(pairs(3, 0, 0, 0));
    const padded = inferAblation(pairs(3, 0, 500, 500));
    expect(few.verdict).toBe('underpowered');
    expect(padded.verdict).toBe('underpowered');
    expect(padded.pValue).toBeCloseTo(few.pValue, 12);
  });

  it('handles the empty run without inventing a lift', () => {
    const r = inferAblation([]);
    expect(r.lift).toBeNull();
    expect(r.verdict).toBe('underpowered');
  });
});

describe('wilsonInterval', () => {
  it('brackets the point estimate', () => {
    const [lo, hi] = wilsonInterval(7, 10);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
  });

  it('does not claim certainty at the extremes (where Wald does)', () => {
    // 10/10 is not proof of a 100% pass rate. Wald gives [1, 1] here and lies.
    const [lo, hi] = wilsonInterval(10, 10);
    expect(lo).toBeLessThan(1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThan(0.6);

    const [zlo, zhi] = wilsonInterval(0, 10);
    expect(zlo).toBe(0);
    expect(zhi).toBeGreaterThan(0);
  });

  it('narrows as n grows', () => {
    const width = (k: number, n: number) => {
      const [lo, hi] = wilsonInterval(k, n);
      return hi - lo;
    };
    expect(width(50, 100)).toBeLessThan(width(5, 10));
    expect(width(500, 1000)).toBeLessThan(width(50, 100));
  });

  it('is [0,0] for an empty sample rather than NaN', () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });
});

describe('campaign planning — where to aim the ablation', () => {
  it('a saturated case can NEVER inform an ablation, however cheap it looks', () => {
    // Always-passes and never-passes are both worthless: the scaffold cannot change
    // an outcome that never varies. This is not "needs more reps" — it is infinite
    // reps, i.e. never.
    expect(expectedDiscordantRate(1)).toBe(0);
    expect(expectedDiscordantRate(0)).toBe(0);
    expect(requiredRepsForPower(1)).toBe(Infinity);
    expect(requiredRepsForPower(0)).toBe(Infinity);
  });

  it('information peaks at a coin-flip case', () => {
    expect(expectedDiscordantRate(0.5)).toBeCloseTo(0.5, 6);
    expect(expectedDiscordantRate(0.5)).toBeGreaterThan(expectedDiscordantRate(0.8));
    expect(expectedDiscordantRate(0.5)).toBeGreaterThan(expectedDiscordantRate(0.2));
  });

  it('converts a reliability baseline into reps-per-case', () => {
    // The measured baseline: no-stub-in-write is a 52% coin flip (the most
    // informative case in the suite), grep-for-todo is 88%, and read-single-file
    // passes 25/25 — which makes it useless for ablation no matter how fast it runs.
    expect(requiredRepsForPower(0.52)).toBe(13); // ceil(6 / 0.4992)
    expect(requiredRepsForPower(0.88)).toBe(29); // ceil(6 / 0.2112)
    expect(requiredRepsForPower(1.0)).toBe(Infinity);
  });

  it('ranks the real baseline by information, and flags the saturated cases', () => {
    const plan = planAblationCampaign([
      { caseId: 'read-single-file', passes: 25, trials: 25 },
      { caseId: 'grep-for-todo', passes: 22, trials: 25 },
      { caseId: 'no-stub-in-write', passes: 13, trials: 25 },
      { caseId: 'plan-mode-no-tools', passes: 25, trials: 25 },
    ]);

    expect(plan[0].caseId).toBe('no-stub-in-write'); // nearest a coin flip → most informative
    expect(plan[1].caseId).toBe('grep-for-todo');
    // The two 25/25 cases are last, and explicitly unusable rather than quietly
    // dropped — a plan that silently omits them looks like it covered the suite.
    expect(
      plan
        .filter((c) => !c.usable)
        .map((c) => c.caseId)
        .sort(),
    ).toEqual(['plan-mode-no-tools', 'read-single-file']);
  });

  it('explains the SWE campaign: the floor regime carries no information at ANY n', () => {
    // 2/50 resolved → ~4% pass rate → almost every pair concordant-fail. The
    // campaign concluded it needed more tasks (the field runs 300-500). It did not.
    // It needed DIFFERENT tasks — ones the model can sometimes solve.
    const floor = expectedDiscordantRate(2 / 50);
    expect(floor).toBeLessThan(0.08);
    // Even 500 tasks in that regime yield only a handful of discordant pairs…
    expect(Math.round(floor * 500)).toBeLessThan(40);
    // …while the same GPU spent on coin-flip cases yields an order more.
    expect(expectedDiscordantRate(0.5) * 500).toBeGreaterThan(floor * 500 * 6);
  });
});
