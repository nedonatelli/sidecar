// ---------------------------------------------------------------------------
// SWE-bench Verified — data model (external benchmark Phase 2).
//
// A SYSTEM-LEVEL benchmark: it scores the whole agent (SideCar's loop + a model
// + a real repo), end-to-end, on real GitHub issues. The flagship metric is an
// ABLATION — the same model run with the scaffolding harness ON vs OFF — because
// the delta is the thing no bare agent-wrapper can produce.
//
// Scoring (apply the patch, run the repo's FAIL_TO_PASS + PASS_TO_PASS tests in
// the task's environment) is DELEGATED to the official `swebench` harness, which
// is Docker-based. This module never runs tests; it produces predictions in the
// official format and computes the ablation from the harness's resolved report.
// See bench/swe/README.md for the end-to-end protocol.
// ---------------------------------------------------------------------------

/** One SWE-bench task (a real GitHub issue + its test oracle). */
export interface SweTask {
  /** e.g. "django__django-12345" — the official prediction key. */
  instance_id: string;
  /** "owner/repo". */
  repo: string;
  /** Commit to check the repo out at before the agent runs. */
  base_commit: string;
  /** The issue text handed to the agent as the task. */
  problem_statement: string;
  /** Tests that must flip fail→pass for the task to count as resolved. */
  fail_to_pass: string[];
  /** Tests that must stay passing (no regressions). */
  pass_to_pass: string[];
  /** The reference fix (NOT shown to the agent — for analysis only). */
  patch?: string;
  /** Python version / env hint, when present. */
  version?: string;
}

/**
 * Ablation arms. The core two are `scaffold-on` (full harness) vs `scaffold-off`
 * (bare loop). `gate-only` / `critic-only` decompose the harness to localize
 * *which* scaffold helps or harms (the do-no-harm investigation).
 */
export type ArmName = 'scaffold-on' | 'scaffold-off' | 'gate-only' | 'critic-only';

/** A generated prediction for one task on one arm. */
export interface SwePrediction {
  instance_id: string;
  arm: ArmName;
  /** Unified diff the agent produced (empty string = no edit / gave up). */
  model_patch: string;
  /** Wall-clock for the agent run, for the latency side of the ablation. */
  durationMs: number;
  /**
   * F1 failure-taxonomy bucket the loop classified this run into (null =
   * natural completion). Diagnostic only — never reaches the official
   * predictions JSONL (toPredictionsJsonl projects instance_id/model_patch
   * only); it's the "why did this run end" signal for investigating scaffold
   * behavior (e.g. do-no-harm bail-early analysis). Undefined for older
   * predictions.meta.jsonl files written before this field existed.
   */
  terminationBucket?: import('../../src/agent/failureTaxonomy.js').FailureBucket | null;
}

/** One line of the official `swebench` predictions JSONL. */
export interface OfficialPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface ArmReport {
  arm: ArmName;
  resolved: number;
  total: number;
  /** resolved / total in [0,1]. */
  resolveRate: number;
  /** Mean agent wall-clock across the arm's tasks. */
  meanDurationMs: number;
  /** instance_ids the official harness marked resolved. */
  resolvedIds: string[];
  /** Tasks where the agent produced no patch at all. */
  emptyPatches: number;
}

/**
 * Statistical rigor on the paired ablation (workstreams #1). Without this the
 * lift is a bare point estimate; with it every claim carries uncertainty and a
 * significance verdict, so a noise-sized lift can't masquerade as a real one.
 */
export interface AblationSignificance {
  /** Discordant pairs the harness rescued (on✓/off✗) — McNemar's b. */
  rescued: number;
  /** Discordant pairs the harness regressed (on✗/off✓) — McNemar's c. */
  regressed: number;
  /** rescued + regressed. The only pairs that carry effect information. */
  discordant: number;
  /** McNemar exact two-sided p-value for "harness has no effect". */
  pValue: number;
  /** pValue < 0.05 — is the lift distinguishable from noise at this n? */
  significant: boolean;
  /** Wilson 95% CI for the scaffold-on resolve rate, [low, high]. */
  onCI: [number, number];
  /** Wilson 95% CI for the scaffold-off resolve rate. */
  offCI: [number, number];
  /** 95% CI for the lift (paired difference of rates). */
  liftCI: [number, number];
}

export interface AblationReport {
  on: ArmReport;
  off: ArmReport;
  /** resolveRate(on) − resolveRate(off). The headline number: harness lift. */
  liftPct: number;
  /** Tasks resolved ONLY with the harness on (what the scaffolding rescued). */
  rescuedIds: string[];
  /** Tasks resolved ONLY with the harness off (scaffolding regressions). */
  regressedIds: string[];
  /** meanDuration(on) − meanDuration(off): the latency the harness costs. */
  latencyDeltaMs: number;
  /** Uncertainty + significance on the paired lift. */
  significance: AblationSignificance;
}
