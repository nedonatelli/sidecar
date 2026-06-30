// ---------------------------------------------------------------------------
// SWE-bench ablation report — the flagship output.
//
// Leads with the harness lift (resolve-rate Δ), then the per-arm rates, the
// rescued/regressed task lists, the latency the harness cost, and the
// reproducibility envelope. Per ADR-006: weight-class-relative framing, the
// ablation delta is the headline, the raw rate is support.
// ---------------------------------------------------------------------------

import type { AblationReport } from './types.js';

export interface SweEnvelope {
  model: string;
  quantization: string;
  backend: string;
  contextTokens: number;
  /** "SWE-bench_Verified slice (N)" + any repo filter. */
  dataset: string;
  taskCount: number;
  maxIterations: number;
  swebenchHarnessVersion: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const sec = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;

export function formatAblationReport(report: AblationReport, env: SweEnvelope): string {
  const lift = report.liftPct;
  const lines: string[] = [];
  lines.push(`# SWE-bench Verified ablation — ${env.model}`);
  lines.push('');
  lines.push(`## Headline: scaffolding lift = ${lift >= 0 ? '+' : ''}${pct(lift)}`);
  lines.push('');
  lines.push(
    `Same model, same ${env.taskCount}-task slice, same seed — only the SideCar harness differs. ` +
      `This delta is the number a bare agent-wrapper cannot produce.`,
  );
  lines.push('');
  lines.push('## Reproducibility envelope');
  lines.push('');
  lines.push(
    `- model: \`${env.model}\` (${env.backend}), quantization: **${env.quantization}**, context: ${env.contextTokens}`,
  );
  lines.push(`- dataset: ${env.dataset} · max agent iterations: ${env.maxIterations}`);
  lines.push(`- scored by official swebench harness ${env.swebenchHarnessVersion}`);
  lines.push('');
  lines.push('## Resolve rates');
  lines.push('');
  lines.push('| Arm | Resolved | Rate | Empty patches | Mean latency |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const a of [report.on, report.off]) {
    lines.push(
      `| ${a.arm} | ${a.resolved} / ${a.total} | ${pct(a.resolveRate)} | ${a.emptyPatches} | ${sec(a.meanDurationMs)} |`,
    );
  }
  lines.push('');
  lines.push(
    `Latency cost of the harness: ${report.latencyDeltaMs >= 0 ? '+' : ''}${sec(report.latencyDeltaMs)} per task.`,
  );
  lines.push('');
  if (report.rescuedIds.length) {
    lines.push(`**Rescued by the harness** (${report.rescuedIds.length}): ${report.rescuedIds.join(', ')}`);
  }
  if (report.regressedIds.length) {
    lines.push(`**Regressed by the harness** (${report.regressedIds.length}): ${report.regressedIds.join(', ')}`);
  }
  return lines.join('\n');
}
