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
    });
  }

  return summaries.sort((a, b) => b.lift - a.lift);
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
  }
  return lines.join('\n');
}
