// ---------------------------------------------------------------------------
// Scaffold ablation analysis (scaffolding roadmap M2).
//
// For local-first we cannot assume a model-based scaffold helps — a same-model
// self-check shares the model's blind spots, and every scaffold costs latency
// that bites hardest on slow local models. M2 answers, per scaffold: does it
// LIFT pass-rate, and at what LATENCY cost, on the one model the user runs?
//
// The real-model runner (tests/llm-eval/) runs each case with and without a
// scaffold and feeds the tagged results here. This module is the pure
// aggregation — no I/O, no model — so it unit-tests cleanly and the runner is
// the only part that needs a live model.
// ---------------------------------------------------------------------------

import { inferAblation, type AblationInference, type Pair } from './ablationStats.js';

/** One eval run, tagged with which scaffold was toggled and whether it was active. */
export interface AblationRun {
  /** Scaffold under test, e.g. 'completionGate' | 'analysisCritic' | 'autoFix'. */
  scaffold: string;
  /** Was the scaffold active for this run? */
  present: boolean;
  caseId: string;
  /**
   * Repetition index. With it, the two arms of the same (scaffold, caseId, rep)
   * form a PAIR — and a paired binary comparison is the only one with any power
   * here, because between-case difficulty (a case is either within the model's
   * reach or it isn't) swamps the scaffold effect in an unpaired test. The runner
   * seeds both arms of a pair identically, so a pair differs only in the scaffold.
   */
  rep?: number;
  passed: boolean;
  durationMs: number;
  /**
   * Graded per-run metrics (counts/rates), e.g. `unresolvedCitations`.
   * Verify-layer scaffolds are invisible to binary pass/fail — a real review
   * always cites at least one conventional non-source path, so a
   * perfection-or-fail scorer fails BOTH arms and lift is uncomputable
   * (M1/M2 finding). Comparing metric MEANS across arms reads the reduction
   * directly (e.g. 2.1 → 0.4 avg fabrications per run).
   */
  metrics?: Record<string, number>;
}

/** Mean of one graded metric in each arm, and the with−without delta. */
export interface MetricDelta {
  metric: string;
  meanWith: number;
  meanWithout: number;
  /** meanWith − meanWithout. For defect counts, negative = the scaffold reduced them. */
  delta: number;
  /** Runs contributing the metric in each arm (metric may be absent on some runs). */
  withN: number;
  withoutN: number;
}

/** Per-scaffold ablation result: lift and latency cost. */
export interface AblationSummary {
  scaffold: string;
  withN: number;
  withoutN: number;
  /** Pass rate in [0,1] with the scaffold active. */
  passRateWith: number;
  /** Pass rate in [0,1] with the scaffold removed. */
  passRateWithout: number;
  /** passRateWith − passRateWithout. Positive = the scaffold helped. */
  lift: number;
  /** Mean run duration (ms) with the scaffold active. */
  latencyWithMs: number;
  latencyWithoutMs: number;
  /** latencyWithMs − latencyWithoutMs. Positive = the scaffold cost time. */
  latencyDeltaMs: number;
  /** Graded-metric means per arm, one entry per metric name observed. */
  metricDeltas: MetricDelta[];
  /**
   * Paired inference: exact McNemar over the discordant pairs, plus an honesty
   * gate that refuses to call a lift it had no power to see. `lift` above is a
   * point estimate and, on its own, has repeatedly been read as a finding when it
   * was noise — this is the number that decides.
   */
  inference: AblationInference;
}

/**
 * Pair the two arms of each (caseId, rep). A run without a partner is dropped: an
 * unpaired run cannot say anything about the scaffold, and silently folding it
 * into a marginal pass-rate is how an unpaired comparison manufactures lift out of
 * case-difficulty imbalance.
 */
function buildPairs(group: AblationRun[]): Pair[] {
  const byKey = new Map<string, { on?: boolean; off?: boolean }>();
  for (const r of group) {
    const key = `${r.caseId}#${r.rep ?? 0}`;
    const slot = byKey.get(key) ?? {};
    if (r.present) slot.on = r.passed;
    else slot.off = r.passed;
    byKey.set(key, slot);
  }
  const pairs: Pair[] = [];
  for (const { on, off } of byKey.values()) {
    if (on === undefined || off === undefined) continue; // no partner → no information
    pairs.push({ withScaffold: on, withoutScaffold: off });
  }
  return pairs;
}

function mean(ns: number[]): number {
  return ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length;
}

/**
 * Aggregate tagged ablation runs into one summary per scaffold, sorted by lift
 * descending (most-helpful first). A scaffold with lift ≤ 0 and positive
 * latency delta is pure tax — the harness/operator should consider cutting it.
 */
export function summarizeAblation(runs: AblationRun[]): AblationSummary[] {
  const byScaffold = new Map<string, AblationRun[]>();
  for (const r of runs) {
    const list = byScaffold.get(r.scaffold) ?? [];
    list.push(r);
    byScaffold.set(r.scaffold, list);
  }

  const summaries: AblationSummary[] = [];
  for (const [scaffold, group] of byScaffold) {
    const withRuns = group.filter((r) => r.present);
    const withoutRuns = group.filter((r) => !r.present);
    const passRateWith = withRuns.length === 0 ? 0 : withRuns.filter((r) => r.passed).length / withRuns.length;
    const passRateWithout =
      withoutRuns.length === 0 ? 0 : withoutRuns.filter((r) => r.passed).length / withoutRuns.length;
    const latencyWithMs = mean(withRuns.map((r) => r.durationMs));
    const latencyWithoutMs = mean(withoutRuns.map((r) => r.durationMs));
    summaries.push({
      scaffold,
      withN: withRuns.length,
      withoutN: withoutRuns.length,
      passRateWith,
      passRateWithout,
      lift: passRateWith - passRateWithout,
      latencyWithMs,
      latencyWithoutMs,
      latencyDeltaMs: latencyWithMs - latencyWithoutMs,
      metricDeltas: summarizeMetrics(withRuns, withoutRuns),
      inference: inferAblation(buildPairs(group)),
    });
  }

  return summaries.sort((a, b) => b.lift - a.lift);
}

/** Per-metric means across arms. A metric contributes only from runs that
 *  recorded it, so mixing metric-bearing and legacy runs doesn't skew means. */
function summarizeMetrics(withRuns: AblationRun[], withoutRuns: AblationRun[]): MetricDelta[] {
  const names = new Set<string>();
  for (const r of [...withRuns, ...withoutRuns]) {
    for (const name of Object.keys(r.metrics ?? {})) names.add(name);
  }

  const deltas: MetricDelta[] = [];
  for (const metric of [...names].sort()) {
    const withVals = withRuns.map((r) => r.metrics?.[metric]).filter((v): v is number => typeof v === 'number');
    const withoutVals = withoutRuns.map((r) => r.metrics?.[metric]).filter((v): v is number => typeof v === 'number');
    const meanWith = mean(withVals);
    const meanWithout = mean(withoutVals);
    deltas.push({
      metric,
      meanWith,
      meanWithout,
      delta: meanWith - meanWithout,
      withN: withVals.length,
      withoutN: withoutVals.length,
    });
  }
  return deltas;
}

/** Render an ablation summary table for the eval report. */
export function formatAblationReport(summaries: AblationSummary[]): string {
  if (summaries.length === 0) return 'No ablation runs.';
  const lines: string[] = [];
  lines.push('Scaffold ablation — lift (pass-rate Δ) vs latency cost:');
  lines.push('');
  for (const s of summaries) {
    const inf = s.inference;
    const latency = `${s.latencyDeltaMs >= 0 ? '+' : ''}${(s.latencyDeltaMs / 1000).toFixed(1)}s`;

    // The verdict comes from the PAIRED TEST, never from the sign of the point
    // estimate. `lift > 0 → HELPS` was the old rule, and it would call a 1-of-1
    // coin flip a win — the exact error the SWE campaign's n=1 "+100%" made.
    const label =
      inf.verdict === 'helps'
        ? 'HELPS'
        : inf.verdict === 'hurts'
          ? 'HURTS'
          : inf.verdict === 'no-effect'
            ? 'no effect'
            : 'NO POWER';

    const liftText =
      inf.verdict === 'underpowered'
        ? 'lift unmeasured'
        : `lift ${(inf.lift ?? 0) > 0 ? '+' : ''}${((inf.lift ?? 0) * 100).toFixed(0)}pts ` +
          `(${(s.passRateWithout * 100).toFixed(0)}%→${(s.passRateWith * 100).toFixed(0)}%)`;

    lines.push(
      `  ${s.scaffold.padEnd(18)} ${label.padEnd(9)} ${liftText} ` +
        `p=${inf.pValue.toFixed(3)} disc=${inf.outcome.b}/${inf.outcome.c} ` +
        `latency ${latency}  [pairs=${inf.pairs}]`,
    );
    if (inf.verdict === 'underpowered') lines.push(`  ${''.padEnd(18)} → ${inf.explanation}`);
    // Graded metrics: for defect counts the readable direction is
    // without→with (the scaffold REDUCES the count when the arrow drops).
    for (const m of s.metricDeltas) {
      if (m.withN === 0 && m.withoutN === 0) continue;
      const dir = m.delta < 0 ? 'REDUCES' : m.delta > 0 ? 'RAISES' : 'no effect';
      lines.push(
        `  ${''.padEnd(18)} ${dir.padEnd(9)} ` +
          `${m.metric} ${m.meanWithout.toFixed(2)}→${m.meanWith.toFixed(2)} per run ` +
          `(Δ ${m.delta >= 0 ? '+' : ''}${m.delta.toFixed(2)})  [n=${m.withN}/${m.withoutN}]`,
      );
    }
  }
  return lines.join('\n');
}
