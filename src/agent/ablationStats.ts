// Inference for scaffold ablation — turn a pass-rate delta into a claim you can defend.
//
// `summarizeAblation` reports `lift = passRateWith − passRateWithout` and nothing
// else. No interval, no p-value, no notion of power. A +0.15 lift measured over
// five runs of a stochastic 7B prints identically to a real effect, and the whole
// point of the ablation harness is to decide whether a scaffold earns its keep.
// The SWE campaign already learned this the hard way — an n=1 "+100%" — and its
// write-up says plainly that at 2/50 resolved "the instrument has no power to
// detect a scaffold effect, and it SAYS SO rather than printing a misleading
// number." That honesty was applied by hand. This module makes it automatic.
//
// ## Why the design is PAIRED
//
// Runs are paired by (scaffold, caseId, rep): the same case, the same repetition
// index, once with the scaffold and once without. Given common random numbers
// (the runner seeds both arms of a pair identically), the pair differs only in the
// scaffold. Pairing removes between-case difficulty — by far the largest variance
// component, since a case either is or isn't within a model's reach — and it is
// what makes a handful of reps informative at all.
//
// In a paired binary design only the DISCORDANT pairs carry information:
//
//     b = scaffold PASSED, no-scaffold FAILED   (the scaffold rescued the run)
//     c = scaffold FAILED, no-scaffold PASSED   (the scaffold broke the run)
//
// Pairs where both arms agree tell you the case is easy or impossible — they say
// nothing about the scaffold. This is McNemar's test, and it is exactly the right
// instrument: `b + c` IS the sample size, no matter how many runs you did.
//
// ## The honesty gate
//
// With the two-sided exact test, the smallest reachable p-value on `n = b + c`
// discordant pairs is `2 · 0.5^n`. So:
//
//     n = 0 → no evidence at all       n = 4 → best possible p = 0.125
//     n = 5 → best possible p = 0.0625 n = 6 → best possible p = 0.031  ← first n
//                                                                        that can
//                                                                        reach 0.05
//
// Below six discordant pairs, significance at α = 0.05 is ARITHMETICALLY
// IMPOSSIBLE — even if every discordant pair favors the scaffold. A run like that
// has not produced a weak result; it has produced NO result, and reporting its
// lift as a number invites exactly the false claim this exists to prevent. So the
// verdict is `underpowered`, and the lift is reported as unmeasured.

/** Minimum discordant pairs at which a two-sided exact McNemar test can reach p < 0.05.
 *  2·0.5^5 = 0.0625 > 0.05; 2·0.5^6 = 0.03125 < 0.05. */
export const MIN_DISCORDANT_FOR_SIGNIFICANCE = 6;

export const ALPHA = 0.05;

export type AblationVerdict =
  /** The scaffold significantly improved the pass rate. */
  | 'helps'
  /** The scaffold significantly HURT the pass rate — cut it. */
  | 'hurts'
  /** Enough discordant pairs to have seen an effect; none found. */
  | 'no-effect'
  /** Too few discordant pairs for ANY conclusion. Not a weak result — no result. */
  | 'underpowered';

export interface PairedOutcome {
  /** Scaffold passed, control failed. */
  b: number;
  /** Scaffold failed, control passed. */
  c: number;
  /** Both arms passed. */
  bothPass: number;
  /** Both arms failed. */
  bothFail: number;
}

export interface AblationInference {
  pairs: number;
  outcome: PairedOutcome;
  /** b + c. The real sample size of a paired binary comparison. */
  discordant: number;
  /** Two-sided exact McNemar p-value. 1 when there are no discordant pairs. */
  pValue: number;
  /** Paired lift = (b − c) / pairs. Null when there are no pairs. */
  lift: number | null;
  verdict: AblationVerdict;
  /** Plain-language reading, safe to print verbatim in a report. */
  explanation: string;
}

/** n choose k, exact for the small n a paired eval produces. */
function binom(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Two-sided exact McNemar p-value. Under the null the scaffold changes nothing,
 * so each discordant pair is a fair coin: b ~ Binomial(b + c, 0.5).
 *
 * Exact rather than the χ² approximation, because a local-model ablation produces
 * single-digit discordant counts and χ² is not trustworthy there — which is
 * precisely the regime where a wrong p-value would do the most damage.
 */
export function mcnemarExactP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const lo = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= lo; i++) tail += binom(n, i);
  const p = 2 * tail * Math.pow(0.5, n);
  return Math.min(1, p);
}

/** Wilson score interval for a binomial proportion — behaves at the 0/1 extremes,
 *  where Wald produces a zero-width interval and lies about certainty. */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** One paired trial: the same case + rep, run with and without the scaffold. */
export interface Pair {
  withScaffold: boolean;
  withoutScaffold: boolean;
}

/**
 * Infer whether a scaffold helps, from paired outcomes. Never reports a lift it
 * cannot see: with fewer than MIN_DISCORDANT_FOR_SIGNIFICANCE discordant pairs the
 * verdict is `underpowered`, because significance is arithmetically unreachable
 * there and a printed number would be read as a finding.
 */
export function inferAblation(pairs: readonly Pair[]): AblationInference {
  const outcome: PairedOutcome = { b: 0, c: 0, bothPass: 0, bothFail: 0 };
  for (const p of pairs) {
    if (p.withScaffold && !p.withoutScaffold) outcome.b++;
    else if (!p.withScaffold && p.withoutScaffold) outcome.c++;
    else if (p.withScaffold && p.withoutScaffold) outcome.bothPass++;
    else outcome.bothFail++;
  }

  const discordant = outcome.b + outcome.c;
  const pValue = mcnemarExactP(outcome.b, outcome.c);
  const lift = pairs.length === 0 ? null : (outcome.b - outcome.c) / pairs.length;

  if (discordant < MIN_DISCORDANT_FOR_SIGNIFICANCE) {
    const best = discordant === 0 ? 1 : 2 * Math.pow(0.5, discordant);
    return {
      pairs: pairs.length,
      outcome,
      discordant,
      pValue,
      lift,
      verdict: 'underpowered',
      explanation:
        `${pairs.length} pairs but only ${discordant} discordant ` +
        `(${outcome.b} rescued by the scaffold, ${outcome.c} broken by it). ` +
        `The best p-value reachable on ${discordant} discordant pairs is ${best.toFixed(3)}, so ` +
        `significance at ${ALPHA} is arithmetically impossible — this is NOT a weak result, it is ` +
        `no result. Need at least ${MIN_DISCORDANT_FOR_SIGNIFICANCE} discordant pairs; ` +
        `run more reps or pick cases the scaffold actually bites on.`,
    };
  }

  if (pValue < ALPHA) {
    const helps = outcome.b > outcome.c;
    return {
      pairs: pairs.length,
      outcome,
      discordant,
      pValue,
      lift,
      verdict: helps ? 'helps' : 'hurts',
      explanation:
        `${helps ? 'HELPS' : 'HURTS'}: of ${discordant} discordant pairs, the scaffold rescued ` +
        `${outcome.b} and broke ${outcome.c} (exact McNemar p = ${pValue.toFixed(4)}). ` +
        `Paired lift ${((lift ?? 0) * 100).toFixed(1)} points over ${pairs.length} pairs.`,
    };
  }

  return {
    pairs: pairs.length,
    outcome,
    discordant,
    pValue,
    lift,
    verdict: 'no-effect',
    explanation:
      `No detectable effect: ${discordant} discordant pairs split ${outcome.b}/${outcome.c} ` +
      `(exact McNemar p = ${pValue.toFixed(4)}). The instrument had the power to see an effect ` +
      `this size and did not. A scaffold with no lift and a latency cost is pure tax.`,
  };
}

// ---------------------------------------------------------------------------
// Campaign planning: WHERE to aim the ablation.
//
// Discordant pairs are the only informative ones, and they only occur where the
// outcome can go either way. If both arms sit near a pass rate p, the chance that
// a given pair is discordant is 2p(1−p): maximal at p = 0.5, and ZERO at p = 0 or
// p = 1. A case the model always solves passes with and without the scaffold; a
// case it never solves fails both ways. Neither can ever tell you anything, no
// matter how many times you run it.
//
// This is the real lesson of the 50-task SWE campaign. It reported "zero discordant
// pairs" and no power, and concluded it needed more tasks (the field runs 300-500).
// But at 2/50 resolved, nearly every task is simply beyond a 7B — both arms fail,
// every pair is concordant, and the information content is zero BY CONSTRUCTION.
// Running 500 tasks in the floor regime would have bought exactly nothing. The
// campaign was not under-sampled; it was AIMED WRONG.
//
// Ablations belong in the transition regime — the cases the model sometimes solves
// — because those are the only ones where a guard can change the answer. The
// reliability baseline (pass rate per case over N trials) is what identifies them.
// ---------------------------------------------------------------------------

/** Expected fraction of pairs that will be discordant, for a case with pass rate `p`. */
export function expectedDiscordantRate(passRate: number): number {
  return 2 * passRate * (1 - passRate);
}

/**
 * Reps needed for this case to yield MIN_DISCORDANT_FOR_SIGNIFICANCE discordant
 * pairs in expectation. Infinity when the case is saturated (always or never
 * passes) — it can never contribute information, and belongs nowhere near an
 * ablation campaign however cheap it looks.
 */
export function requiredRepsForPower(passRate: number): number {
  const rate = expectedDiscordantRate(passRate);
  if (rate <= 0) return Infinity;
  return Math.ceil(MIN_DISCORDANT_FOR_SIGNIFICANCE / rate);
}

export interface CasePlan {
  caseId: string;
  passRate: number;
  /** Expected discordant pairs per rep. Higher = more information per unit of GPU. */
  informationPerRep: number;
  /** Reps needed for a conclusive result, or Infinity when the case is saturated. */
  requiredReps: number;
  usable: boolean;
}

/**
 * Rank cases by how much they can actually tell us, most-informative first.
 * Saturated cases are marked unusable rather than quietly dropped — a campaign
 * plan that silently omits them looks like it covered the suite when it did not.
 */
export function planAblationCampaign(
  baseline: ReadonlyArray<{ caseId: string; passes: number; trials: number }>,
): CasePlan[] {
  return baseline
    .map(({ caseId, passes, trials }) => {
      const passRate = trials === 0 ? 0 : passes / trials;
      const informationPerRep = expectedDiscordantRate(passRate);
      const requiredReps = requiredRepsForPower(passRate);
      return { caseId, passRate, informationPerRep, requiredReps, usable: Number.isFinite(requiredReps) };
    })
    .sort((a, b) => b.informationPerRep - a.informationPerRep);
}

// ---------------------------------------------------------------------------
// Three arms, not two.
//
// A two-arm ablation (scaffold on vs off) answers "does this guard help?". It
// cannot answer the question SideCar actually stakes its design on, which is
// whether ADAPTING the scaffolding per model beats picking one setting and
// leaving it there. That needs three arms, run on the same cases with the same
// seeds:
//
//   bare      — no harness. The model, the tools, nothing else. The floor.
//   always-on — every guard on, fixed, for every model. The naive maximum.
//   dynamic   — the tier system: scaffolding chosen from the model's measured
//               capability. What SideCar now ships by default.
//
// The three pairwise contrasts each falsify a different claim:
//
//   dynamic vs bare      — does the harness help at all? If not, the product is
//                          a UI over Ollama.
//   always-on vs bare    — does scaffolding help when applied indiscriminately?
//   dynamic vs always-on — does ADAPTING beat a fixed maximum? This is the one
//                          nobody has ever run, and it is the one that decides
//                          whether the tier machinery earns its complexity. If
//                          dynamic ≈ always-on, the capability tiers, the learner
//                          and the baselines are all elaborate no-ops. If dynamic
//                          BEATS always-on, that is the moat, stated as a number.
//
// Note that always-on can lose to bare, and it is not a stretch: the critic ran
// as a blocking guard for months and made runs bail EARLY. "More scaffolding" is
// a hypothesis, not a direction.
// ---------------------------------------------------------------------------

/** One run tagged with the arm it belongs to. Pairing is by (caseId, rep). */
export interface ArmedRun {
  arm: string;
  caseId: string;
  rep: number;
  passed: boolean;
}

export interface ArmContrast {
  armA: string;
  armB: string;
  /** Inference for "A relative to B" — b = A passed & B failed. */
  inference: AblationInference;
}

/**
 * Pair two arms on their shared (caseId, rep) keys and infer. Runs without a
 * counterpart in the other arm are dropped: an unpaired run carries no
 * information about the contrast, and folding it into a marginal rate is how an
 * unpaired comparison invents a lift out of case-difficulty imbalance.
 */
export function contrastArms(runs: readonly ArmedRun[], armA: string, armB: string): ArmContrast {
  const key = (r: ArmedRun) => `${r.caseId}#${r.rep}`;
  const a = new Map<string, boolean>();
  const b = new Map<string, boolean>();
  for (const r of runs) {
    if (r.arm === armA) a.set(key(r), r.passed);
    else if (r.arm === armB) b.set(key(r), r.passed);
  }

  const pairs: Pair[] = [];
  for (const [k, passedA] of a) {
    const passedB = b.get(k);
    if (passedB === undefined) continue;
    pairs.push({ withScaffold: passedA, withoutScaffold: passedB });
  }
  return { armA, armB, inference: inferAblation(pairs) };
}

/** Every pairwise contrast among `arms`, in the order given. */
export function contrastAllArms(runs: readonly ArmedRun[], arms: readonly string[]): ArmContrast[] {
  const out: ArmContrast[] = [];
  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      out.push(contrastArms(runs, arms[i], arms[j]));
    }
  }
  return out;
}

/** Render the pairwise contrasts, verdict first — safe to print verbatim. */
export function renderArmContrasts(contrasts: readonly ArmContrast[]): string {
  const lines: string[] = ['Arm contrasts (paired, exact McNemar):', ''];
  for (const c of contrasts) {
    const i = c.inference;
    const label =
      i.verdict === 'helps'
        ? `${c.armA} BEATS ${c.armB}`
        : i.verdict === 'hurts'
          ? `${c.armA} LOSES TO ${c.armB}`
          : i.verdict === 'no-effect'
            ? `${c.armA} = ${c.armB} (no detectable difference)`
            : `${c.armA} vs ${c.armB}: NO POWER`;
    lines.push(`  ${label}`);
    lines.push(
      `      pairs=${i.pairs} discordant=${i.outcome.b}/${i.outcome.c} p=${i.pValue.toFixed(4)}` +
        (i.verdict === 'underpowered' ? ' — lift unmeasured' : ` lift=${((i.lift ?? 0) * 100).toFixed(1)}pts`),
    );
  }
  return lines.join('\n');
}
