// ---------------------------------------------------------------------------
// Mechanical guards for arm-vs-arm comparisons.
//
// Written after an evening in which nine separate process failures each
// corrupted a result before being noticed: a shrinking denominator, a timeout
// rendered as a capability failure, tool text that moved between harnesses, and
// 1-2 trial differences at n=3 read as signal on an UNSEEDED run at
// temperature 0.2. Every one was small; together they made most of the
// comparisons untrustworthy.
//
// The lesson is not "be more careful" — it is that a comparison harness should
// refuse to emit a number it cannot justify. These functions are that refusal.
// ---------------------------------------------------------------------------

/** How a single trial ended. TIMEOUT is deliberately NOT a failure. */
export type TrialOutcome = 'PASS' | 'FAIL' | 'TIMEOUT';

export interface ArmResult {
  arm: string;
  outcomes: TrialOutcome[];
  /** cases x trials the arm was ASKED to run — the honest denominator. */
  expectedTrials: number;
}

/**
 * A trial that timed out tells you the configuration is too slow, not that the
 * model is incapable. Conflating them flatters slow configs twice over: the
 * failure disappears AND the denominator shrinks.
 *
 * Observed live: an arm reported "7 / 8 passed" on a 3-case x 3-trial run. The
 * missing trial had timed out on the arm whose worst case took 2,946s; the
 * comparison arm ran all 9. 7/8 next to 2/9 read as a rout.
 */
export function scored(r: ArmResult): { passed: number; scored: number; timeouts: number; valid: boolean } {
  const passed = r.outcomes.filter((o) => o === 'PASS').length;
  const timeouts = r.outcomes.filter((o) => o === 'TIMEOUT').length;
  const scoredN = r.outcomes.length - timeouts;
  // Recorded fewer trials than requested => something truncated the run.
  const valid = r.outcomes.length === r.expectedTrials;
  return { passed, scored: scoredN, timeouts, valid };
}

/**
 * Fisher's exact test on the 2x2 pass/fail table.
 *
 * Small n and a binary outcome is exactly the case where eyeballing a
 * difference misleads: at 3 trials per arm, 2/3 vs 0/3 looks decisive and is
 * not. Returns the two-sided p-value.
 */
export function fisherExactP(a: number, b: number, c: number, d: number): number {
  const logFact: number[] = [0];
  for (let i = 1; i <= a + b + c + d + 1; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  const n = a + b + c + d;
  const pOf = (x: number, y: number, z: number, w: number): number =>
    Math.exp(
      logFact[x + y] +
        logFact[z + w] +
        logFact[x + z] +
        logFact[y + w] -
        logFact[n] -
        logFact[x] -
        logFact[y] -
        logFact[z] -
        logFact[w],
    );
  const observed = pOf(a, b, c, d);
  let total = 0;
  const rowA = a + b;
  const colA = a + c;
  for (let x = Math.max(0, colA - (n - rowA)); x <= Math.min(rowA, colA); x++) {
    const p = pOf(x, rowA - x, colA - x, n - rowA - colA + x);
    if (p <= observed * (1 + 1e-9)) total += p;
  }
  return Math.min(1, total);
}

export interface Comparison {
  a: string;
  b: string;
  summary: string;
  conclusive: boolean;
}

/**
 * Compare two arms and SAY SO when the difference cannot be distinguished from
 * sampling. An unseeded run at temperature 0.2 produced 0/3 and 2/3 for the
 * same configuration on the same case an hour apart — the arm did not change,
 * the sample did.
 */
export function compareArms(x: ArmResult, y: ArmResult, alpha = 0.1): Comparison {
  const sx = scored(x);
  const sy = scored(y);
  const invalid = [!sx.valid ? x.arm : '', !sy.valid ? y.arm : ''].filter(Boolean);
  if (invalid.length > 0) {
    return {
      a: x.arm,
      b: y.arm,
      summary: `INVALID — ${invalid.join(' and ')} recorded fewer trials than requested; denominators are not comparable`,
      conclusive: false,
    };
  }
  const p = fisherExactP(sx.passed, sx.scored - sx.passed, sy.passed, sy.scored - sy.passed);
  const conclusive = p <= alpha;
  const note = sx.timeouts + sy.timeouts > 0 ? ` [${sx.timeouts + sy.timeouts} timeout(s) excluded from scoring]` : '';
  return {
    a: x.arm,
    b: y.arm,
    summary:
      `${x.arm} ${sx.passed}/${sx.scored} vs ${y.arm} ${sy.passed}/${sy.scored} — ` +
      `p=${p.toFixed(3)} ${conclusive ? 'CONCLUSIVE' : 'INCONCLUSIVE (within sampling noise)'}${note}`,
    conclusive,
  };
}

/**
 * Trials per arm needed before a difference of this size could be conclusive.
 * Printed up-front so a sweep is sized before it runs rather than interpreted
 * hopefully afterwards.
 */
export function trialsNeeded(rateA: number, rateB: number, alpha = 0.1, max = 60): number {
  for (let n = 2; n <= max; n++) {
    const a = Math.round(rateA * n);
    const b = Math.round(rateB * n);
    if (fisherExactP(a, n - a, b, n - b) <= alpha) return n;
  }
  return max;
}
