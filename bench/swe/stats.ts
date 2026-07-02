// ---------------------------------------------------------------------------
// SWE-bench ablation statistics — turn point estimates into claims with
// uncertainty (workstreams #1: fix the under-powered instrument).
//
// The failure mode this fixes: reporting "scaffolding lift = +X%" as if a bare
// difference of two resolve rates were a fact. At n=50 (let alone the n=1/n=5
// runs that misled us earlier) a lift is indistinguishable from noise unless we
// say so. Two correct tools, both exact / small-n-safe:
//
//   • Wilson score interval — a proportion CI that stays inside [0,1] and is
//     accurate at small n and extreme rates, where the normal approximation
//     (p ± z·√(p(1-p)/n)) gives nonsense (negative bounds, zero width at p=0).
//
//   • McNemar's exact test — the ablation is PAIRED (every task is run both
//     arms), so the only information about the harness effect lives in the
//     DISCORDANT pairs: tasks the harness rescued (on✓/off✗) vs regressed
//     (on✗/off✓). Concordant pairs (both ✓ or both ✗) carry no signal. The
//     exact binomial version is correct even when the discordant count is tiny,
//     which is exactly our regime.
//
// Pure functions, no deps — unit-tested against known values.
// ---------------------------------------------------------------------------

export interface Interval {
  low: number;
  high: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/**
 * Wilson score interval for a binomial proportion. `z` defaults to 1.96 (95%).
 * n=0 returns the maximally-uncertain [0,1].
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: clamp01(center - margin), high: clamp01(center + margin) };
}

/**
 * Binomial CDF P(X ≤ k) for X ~ Binomial(n, p), computed iteratively so no
 * factorial overflows (each term is derived from the previous). k is clamped to
 * [0, n].
 */
export function binomCdf(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  const kk = Math.max(0, Math.min(n, Math.floor(k)));
  const q = 1 - p;
  let term = Math.pow(q, n); // i = 0
  let sum = term;
  for (let i = 1; i <= kk; i++) {
    term *= ((n - i + 1) / i) * (p / q);
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * McNemar's exact two-sided p-value for a paired ablation.
 *
 * `rescued` = discordant pairs where the harness helped (on resolved, off not).
 * `regressed` = discordant pairs where it hurt (off resolved, on not). Under the
 * null (harness has no effect) each discordant pair is a fair coin, so the
 * smaller count follows Binomial(rescued+regressed, ½). No discordant pairs ⇒
 * p=1 (no evidence either way).
 */
export function mcnemarExactP(rescued: number, regressed: number): number {
  const n = rescued + regressed;
  if (n === 0) return 1;
  const m = Math.min(rescued, regressed);
  return Math.min(1, 2 * binomCdf(m, n, 0.5));
}

/**
 * 95% CI for the paired difference in resolve rates (lift = (rescued −
 * regressed) / total). Uses the standard paired-proportion standard error
 * SE = √( b + c − (b−c)²/N ) / N over the discordant counts b, c. Bounds
 * clamped to [−1, 1]. total=0 ⇒ [0,0].
 */
export function pairedDiffCI(rescued: number, regressed: number, total: number, z = 1.96): Interval {
  if (total <= 0) return { low: 0, high: 0 };
  const b = rescued;
  const c = regressed;
  const diff = (b - c) / total;
  const variance = Math.max(0, b + c - Math.pow(b - c, 2) / total);
  const se = Math.sqrt(variance) / total;
  return { low: Math.max(-1, diff - z * se), high: Math.min(1, diff + z * se) };
}
