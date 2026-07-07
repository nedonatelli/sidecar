// ---------------------------------------------------------------------------
// BFCL report formatting.
//
// Renders a run as a markdown table with the mandatory reproducibility envelope
// (model, quantization, context cap, fixture/version, seed, timeout) printed
// alongside the scores — per ADR-006, a number without that envelope is not
// comparable and must not be published.
// ---------------------------------------------------------------------------

import type { BfclReport } from './types.js';
import { summarizeFailures, classifyBfclFailure, failureAxis } from './failureClassifier.js';

export interface RunEnvelope {
  model: string;
  /** e.g. "Q4_K_M" (Ollama default) or "fp16". REQUIRED for comparability. */
  quantization: string;
  backend: string;
  /** Context window actually used (SideCar caps local at 32K). */
  contextTokens: number;
  /** Where the cases came from: "fixtures" or an upstream version tag. */
  dataset: string;
  caseCount: number;
  temperature: number;
  perCaseTimeoutMs: number;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function formatReport(report: BfclReport, env: RunEnvelope): string {
  const lines: string[] = [];
  lines.push(`# BFCL (AST subset) — ${env.model}`);
  lines.push('');
  lines.push('## Reproducibility envelope');
  lines.push('');
  lines.push(`- model: \`${env.model}\` (${env.backend})`);
  lines.push(`- quantization: **${env.quantization}**`);
  lines.push(`- context: ${env.contextTokens} tokens · temperature: ${env.temperature}`);
  lines.push(`- dataset: ${env.dataset} (${env.caseCount} cases) · per-case timeout: ${env.perCaseTimeoutMs} ms`);
  lines.push('');
  lines.push('## Scores');
  lines.push('');
  lines.push('| Category | Accuracy | Passed / Total |');
  lines.push('| --- | --- | --- |');
  for (const c of report.categories) {
    lines.push(`| ${c.category} | ${pct(c.accuracy)} | ${c.passed} / ${c.total} |`);
  }
  lines.push(`| **macro avg** | **${pct(report.macroAccuracy)}** | — |`);
  lines.push(`| **micro (overall)** | **${pct(report.microAccuracy)}** | ${report.passed} / ${report.total} |`);
  lines.push('');
  lines.push(
    '> Macro = unweighted mean of per-category accuracy. This is NOT BFCL’s official weighted overall; ' +
      'report it as "SideCar-measured AST-subset accuracy", weight-class-relative.',
  );
  if (report.meanDurationMs !== undefined) {
    lines.push('');
    lines.push(`Mean per-case latency: **${(report.meanDurationMs / 1000).toFixed(1)}s** (${report.total} cases).`);
  }

  if (report.failures.length > 0) {
    // Failure taxonomy (Phase 0 instrumentation): split failures into the
    // SELECTION axis (wrong/hallucinated/missing function — fixed by per-turn
    // tool subsetting) vs the ARGUMENT axis (wrong value / missing param —
    // fixed by constrained decoding) vs STRUCTURE. This distribution is the
    // number that decides which lever earns the ROI.
    const dist = summarizeFailures(report.failures.map((f) => f.reason));
    lines.push('');
    lines.push('## Failure taxonomy');
    lines.push('');
    lines.push('| Axis | Count | Share | Lever |');
    lines.push('| --- | --- | --- | --- |');
    const levers: Record<string, string> = {
      selection: 'per-turn tool subsetting',
      argument: 'constrained decoding',
      structure: 'prompt / format shaping',
    };
    for (const axis of ['selection', 'argument', 'structure'] as const) {
      const n = dist.byAxis[axis];
      lines.push(`| **${axis}** | ${n} | ${pct(n / dist.total)} | ${levers[axis]} |`);
    }
    lines.push('');
    lines.push(
      'By type: ' +
        Object.entries(dist.byType)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `${t}=${n}`)
          .join(', '),
    );

    lines.push('');
    lines.push('## Failures');
    lines.push('');
    for (const f of report.failures) {
      const type = classifyBfclFailure(f.reason);
      lines.push(`- \`${f.id}\` (${f.category}) [${failureAxis(type)}/${type}]: ${f.reason}`);
    }
  }
  return lines.join('\n');
}
