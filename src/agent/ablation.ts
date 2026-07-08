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

/** One eval run, tagged with which scaffold was toggled and whether it was active. */
export interface AblationRun {
  /** Scaffold under test, e.g. 'completionGate' | 'analysisCritic' | 'autoFix'. */
  scaffold: string;
  /** Was the scaffold active for this run? */
  present: boolean;
  caseId: string;
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
    const liftPct = (s.lift * 100).toFixed(0);
    const sign = s.lift > 0 ? '+' : '';
    const verdict = s.lift > 0 ? 'HELPS' : s.lift < 0 ? 'HURTS' : 'no effect';
    const latency = `${s.latencyDeltaMs >= 0 ? '+' : ''}${(s.latencyDeltaMs / 1000).toFixed(1)}s`;
    lines.push(
      `  ${s.scaffold.padEnd(18)} ${verdict.padEnd(9)} ` +
        `lift ${sign}${liftPct}% (${(s.passRateWithout * 100).toFixed(0)}%→${(s.passRateWith * 100).toFixed(0)}%) ` +
        `latency ${latency}  [n=${s.withN}/${s.withoutN}]`,
    );
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
