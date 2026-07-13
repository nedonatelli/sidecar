// Reliability metrics for multi-trial eval runs (SIDECAR_EVAL_TRIALS > 1).
//
// For local models flakiness is the dominant failure mode: a case that
// passes 2/3 trials is pass@3 ≈ 100% but pass^3 ≈ 0% — "the model can
// solve it" and "the model reliably solves it" are different verdicts and
// the report shows both. Estimator formulas are the standard unbiased
// ones (same as Cline's evals/analysis): given n trials with c passes,
//   pass@k  = 1 − C(n−c, k) / C(n, k)   (≥1 of k fresh trials passes)
//   pass^k  = C(c, k) / C(n, k)          (all k fresh trials pass)

export type ReliabilityVerdict = 'pass' | 'flaky' | 'fail';

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return out;
}

export function passAtK(n: number, c: number, k: number): number {
  return 1 - choose(n - c, k) / choose(n, k);
}

export function passCaretK(n: number, c: number, k: number): number {
  return choose(c, k) / choose(n, k);
}

/** Binary entropy of the pass rate — 0 at 0% or 100%, 1.0 at 50% (maximally flaky). */
export function flakinessScore(n: number, c: number): number {
  const p = c / n;
  if (p === 0 || p === 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

export function verdict(n: number, c: number): ReliabilityVerdict {
  if (c === n) return 'pass';
  if (c === 0) return 'fail';
  return 'flaky';
}

export interface ReliabilityRow {
  caseId: string;
  trials: number;
  passes: number;
}

/** Markdown reliability table for the run report. */
export function renderReliabilityReport(rows: ReliabilityRow[]): string {
  const lines = [
    '## Reliability (multi-trial)',
    '',
    '| case | passes | verdict | pass@1 | flakiness |',
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const v = verdict(r.trials, r.passes);
    const marker = v === 'pass' ? 'PASS' : v === 'fail' ? 'FAIL' : '⚠ FLAKY';
    lines.push(
      `| ${r.caseId} | ${r.passes}/${r.trials} | ${marker} | ${passAtK(r.trials, r.passes, 1).toFixed(2)} | ${flakinessScore(r.trials, r.passes).toFixed(2)} |`,
    );
  }
  const flaky = rows.filter((r) => verdict(r.trials, r.passes) === 'flaky').length;
  lines.push('');
  lines.push(
    `${flaky} flaky case(s) of ${rows.length}. Flaky = solvable but unreliable — investigate before trusting.`,
  );
  return lines.join('\n');
}
