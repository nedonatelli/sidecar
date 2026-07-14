// Decide how much scaffolding a model gets from how it actually performs —
// not from its filename.
//
// Every scaffolding decision SideCar makes (burst caps, reprompt budgets, critic
// on/off, compression thresholds) is driven by a capability tier. That tier used
// to come from `parseParamSizeB(model)` — a regex over the model's NAME.
// `qwen2.5-coder:7b` → 7 → `weak`. `qwen3.5:latest` has no size in its name at
// all, so it fell through to "unknown local model — conservative default" →
// also `weak`. Measured on the 5-case dogfood suite, those two models score 5/5
// and 5/5. They were being permanently scaffolded as if they could not be
// trusted to call a tool.
//
// `buildCapabilityProfile` always had the right input for this — a measured pass
// rate that outranks the name heuristics. Nothing ever supplied it. Meanwhile
// the loop has been classifying every run into a FailureBucket and persisting it,
// so the evidence was already on disk; it just wasn't attributed to a model.
//
// ## Precedence
//
//   1. USER OVERRIDE      — `sidecar.modelTier` / `sidecar.scaffolding.*`.
//                           Absolute. Detection can be wrong; the user gets the
//                           last word and the learner does not second-guess it.
//   2. OBSERVED PERFORMANCE — what this model did in THIS workspace.
//   3. KNOWN-MODEL BASELINE — what it did on OUR test suite (modelBaselines.ts).
//                           A good cold-start prior, not ground truth for someone
//                           else's monorepo.
//   4. NAME HEURISTIC      — the guess of last resort.
//
// ## What counts as evidence
//
//   • ABORTED runs are excluded. `classifyFailureBucket` maps them to `null`
//     (success) — correct for the taxonomy, since a user pressing Stop is not the
//     model's fault, but poison as a learning signal: it would score every
//     cancelled run as proof of competence.
//   • NON-AGENTIC runs are excluded. Answering "what does this file do?" with no
//     tool call is a fine run that says nothing about whether the model can edit
//     code.
//
// ## Why promotion and demotion use DIFFERENT signals
//
// This is the subtle part, and getting it wrong builds an oscillator.
//
// A model's success rate is measured WITH the scaffolding running. So "it
// succeeds 90% of the time" is NOT evidence it can succeed without help —
// qwen2.5-coder passes the add-jsdoc dogfood case only *because* the action
// reprompt drags it back to work after it narrates the edit instead of making
// it. Promote on success and you strip the guards that produced the success,
// then watch the model fail, then add them back, forever.
//
// So the two directions are learned from two different things:
//
//   • DEMOTE on FAILURE — the model needs more help. Evidence: it failed.
//   • PROMOTE on NON-UTILIZATION — the model never reached for the safety net.
//     Zero reprompts, zero gate injections, zero malformed calls, zero degenerate
//     retries, across a sustained run of successes. That is scaffolding-
//     independent evidence, and it is the only honest basis for removing a guard.
//
// The bars are also asymmetric, because the two errors are not equally bad:
// wrongly judging a model weak costs latency, while wrongly judging it strong
// removes the guards that stop it corrupting the user's source tree. Pessimistic
// fast, optimistic slow. When in doubt, more scaffolding.

import type { CapabilityTier } from '../ollama/modelCapability.js';
import type { AgentRunMetrics } from './metrics.js';

/** Runs before we will DEMOTE (add scaffolding). Cheap to be wrong → low bar. */
export const MIN_RUNS_TO_DEMOTE = 3;

/** Runs before we will PROMOTE (remove scaffolding). Expensive to be wrong → high bar. */
export const MIN_RUNS_TO_PROMOTE = 10;

/** Success rate at or below which a model has earned more scaffolding. */
export const DEMOTE_SUCCESS_RATE = 0.5;

/** Success rate a model must sustain before removing a guard is even considered. */
export const PROMOTE_SUCCESS_RATE = 0.9;

/**
 * Share of runs that may have needed ANY scaffolding intervention and still
 * allow promotion. Near zero on purpose: the claim being made is "this model
 * does not use the safety net", so it had better not be using it.
 */
export const PROMOTE_MAX_INTERVENTION_RATE = 0.1;

/**
 * Only recent runs count. A model is not a fixed object — it gets re-quantized,
 * its context window changes, Ollama updates. Judging today's build by a run
 * from three months ago is judging a different model.
 */
export const RECENCY_WINDOW = 30;

const TIER_ORDER: readonly CapabilityTier[] = ['weak', 'medium', 'strong'];

export interface ObservedPerformance {
  model: string;
  /** Evidence-bearing runs: agentic, not aborted. */
  runs: number;
  successes: number;
  /** successes / runs — used to DEMOTE only. */
  successRate: number;
  /** Runs in which the scaffolding had to fire at least once. */
  runsNeedingScaffold: number;
  /** runsNeedingScaffold / runs — used to PROMOTE only. */
  interventionRate: number;
}

/**
 * Summarize a model's observed agentic performance from persisted run metrics.
 * Returns null when the model has no evidence-bearing runs — the caller must
 * then fall back to the baseline/heuristic rather than invent a number.
 */
export function summarizeModelPerformance(runs: readonly AgentRunMetrics[], model: string): ObservedPerformance | null {
  const relevant = runs
    .filter((r) => r.model === model)
    .filter((r) => !r.aborted) // a user pressing Stop is not a verdict on the model
    .filter((r) => r.toolCalls.length > 0) // a chat answer proves nothing about agentic skill
    .slice(-RECENCY_WINDOW);

  if (relevant.length === 0) return null;

  const successes = relevant.filter((r) => (r.failureBucket ?? null) === null).length;
  const runsNeedingScaffold = relevant.filter((r) => (r.scaffoldInterventions ?? 0) > 0).length;

  return {
    model,
    runs: relevant.length,
    successes,
    successRate: successes / relevant.length,
    runsNeedingScaffold,
    interventionRate: runsNeedingScaffold / relevant.length,
  };
}

export interface TierDecision {
  tier: CapabilityTier;
  /** Justification, appended to the capability profile's `reasons` so the UI can explain itself. */
  reason: string;
  /** True when observed performance moved the tier off its baseline. */
  adjusted: boolean;
}

const step = (tier: CapabilityTier, direction: 1 | -1): CapabilityTier => {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, Math.max(0, i + direction))];
};

/**
 * Move a baseline tier by one step, in the direction the evidence supports.
 * Single-stepping is deliberate: a jump from `weak` straight to `strong` would
 * drop every guard at once on the strength of ten runs.
 */
export function adjustTierByPerformance(base: CapabilityTier, obs: ObservedPerformance | null): TierDecision {
  if (!obs) return { tier: base, reason: '', adjusted: false };

  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const sample = `${obs.runs} runs`;

  // DEMOTE on failure. Checked first, and on the lower bar: when a model is
  // struggling, adding scaffolding is the safe move and should not have to wait.
  if (obs.successRate <= DEMOTE_SUCCESS_RATE && obs.runs >= MIN_RUNS_TO_DEMOTE) {
    const tier = step(base, -1);
    const why = `observed ${pct(obs.successRate)} success over ${sample}`;
    return tier === base
      ? { tier, reason: `${why} — already at the most-scaffolded tier`, adjusted: false }
      : { tier, reason: `${why} — more scaffolding`, adjusted: true };
  }

  // PROMOTE only when the model demonstrably never USED the scaffolding. High
  // success alone does not qualify — it may be high *because* of the scaffolding.
  const earnedPromotion =
    obs.runs >= MIN_RUNS_TO_PROMOTE &&
    obs.successRate >= PROMOTE_SUCCESS_RATE &&
    obs.interventionRate <= PROMOTE_MAX_INTERVENTION_RATE;

  if (earnedPromotion) {
    const tier = step(base, +1);
    const why = `observed ${pct(obs.successRate)} success over ${sample} with the scaffolding firing in only ${pct(obs.interventionRate)} of them`;
    return tier === base
      ? { tier, reason: `${why} — already at the least-scaffolded tier`, adjusted: false }
      : { tier, reason: `${why} — less scaffolding`, adjusted: true };
  }

  // Evidence exists but is not decisive. Say so — a silent no-op reads like a bug.
  const blocked =
    obs.runs < MIN_RUNS_TO_PROMOTE
      ? `only ${sample}`
      : obs.successRate < PROMOTE_SUCCESS_RATE
        ? `${pct(obs.successRate)} success`
        : `scaffolding still firing in ${pct(obs.interventionRate)} of runs`;

  return {
    tier: base,
    reason: `observed ${sample} — not decisive (${blocked}), keeping baseline tier`,
    adjusted: false,
  };
}

// ---------------------------------------------------------------------------
// Live signal registry.
//
// `resolveModelCapability` is a synchronous adapter over in-memory signals — it
// already reads `modelSupportsTools()` and the cached context window this way.
// Observed performance joins them through the same door: activation hydrates it
// from the persisted metrics history, and MetricsCollector keeps it warm as runs
// complete. Nothing hydrates it in the eval/bench harness, so learning is inert
// there by construction and benchmark runs stay reproducible.
// ---------------------------------------------------------------------------

let observedRuns: readonly AgentRunMetrics[] = [];
let learningEnabled = true;

/** Seed the observed-performance signal from persisted run history. Call once at activation. */
export function hydrateModelPerformance(runs: readonly AgentRunMetrics[]): void {
  observedRuns = runs;
}

/** Master switch (`sidecar.modelLearning.enabled`). When off, tiers stay at their baseline. */
export function setModelLearningEnabled(enabled: boolean): void {
  learningEnabled = enabled;
}

/** Fold a just-completed run into the live signal so the NEXT run sees it. */
export function recordRunForLearning(run: AgentRunMetrics): void {
  observedRuns = [...observedRuns, run].slice(-200);
}

/** Observed performance for `model`, or null when learning is off or there is no evidence. */
export function getObservedPerformance(model: string): ObservedPerformance | null {
  if (!learningEnabled) return null;
  return summarizeModelPerformance(observedRuns, model);
}

/** Test seam — drop all learned state. */
export function resetModelPerformanceForTests(): void {
  observedRuns = [];
  learningEnabled = true;
}
