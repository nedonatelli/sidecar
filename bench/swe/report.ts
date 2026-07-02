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
  /** Scaffold version that produced the predictions — results are only
   *  comparable across matching versions (see src/agent/scaffoldVersion.ts). */
  scaffoldVersion?: string;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const sec = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;

export function formatAblationReport(report: AblationReport, env: SweEnvelope): string {
  const lift = report.liftPct;
  const sg = report.significance;
  const signedPct = (x: number): string => `${x >= 0 ? '+' : ''}${pct(x)}`;
  const ci = (iv: [number, number]): string => `[${signedPct(iv[0])}, ${signedPct(iv[1])}]`;
  const lines: string[] = [];
  lines.push(`# SWE-bench Verified ablation — ${env.model}`);
  lines.push('');
  lines.push(
    `## Headline: scaffolding lift = ${signedPct(lift)} (95% CI ${ci(sg.liftCI)}), ` +
      `McNemar p = ${sg.pValue.toFixed(3)} — ${sg.significant ? '**significant**' : 'NOT significant'}`,
  );
  lines.push('');
  lines.push(
    `Same model, same ${env.taskCount}-task slice, same seed — only the SideCar harness differs. ` +
      `This delta is the number a bare agent-wrapper cannot produce.`,
  );
  lines.push('');
  // Honesty gate (workstreams #1): a lift whose CI straddles 0 / whose McNemar
  // p ≥ 0.05 is not distinguishable from noise. Say so, and say what it'd take.
  if (!sg.significant) {
    const need = sg.discordant === 0 ? 'any' : 'more';
    lines.push(
      `> ⚠️ **Not statistically resolvable at this n.** Only ${sg.discordant} discordant pair(s) ` +
        `(${sg.rescued} rescued, ${sg.regressed} regressed) — too few to separate this lift from chance ` +
        `(McNemar p = ${sg.pValue.toFixed(3)}). Report the on/off rates below, but do NOT claim a resolve ` +
        `lift until ${need} more tasks move the discordant count into a powered range. The behavioral signals ` +
        `(empty-patch rate, patch size, latency) are the usable evidence meanwhile.`,
    );
    lines.push('');
  }
  lines.push('## Reproducibility envelope');
  lines.push('');
  lines.push(
    `- model: \`${env.model}\` (${env.backend}), quantization: **${env.quantization}**, context: ${env.contextTokens}`,
  );
  lines.push(`- dataset: ${env.dataset} · max agent iterations: ${env.maxIterations}`);
  lines.push(`- scored by official swebench harness ${env.swebenchHarnessVersion}`);
  if (env.scaffoldVersion)
    lines.push(`- **scaffold version: ${env.scaffoldVersion}** (results comparable only across matching versions)`);
  lines.push('');
  lines.push('## Resolve rates');
  lines.push('');
  lines.push('| Arm | Resolved | Rate (95% CI) | Empty patches | Mean latency |');
  lines.push('| --- | --- | --- | --- | --- |');
  const armCI: Record<string, [number, number]> = { [report.on.arm]: sg.onCI, [report.off.arm]: sg.offCI };
  for (const a of [report.on, report.off]) {
    const [lo, hi] = armCI[a.arm];
    lines.push(
      `| ${a.arm} | ${a.resolved} / ${a.total} | ${pct(a.resolveRate)} [${pct(lo)}, ${pct(hi)}] | ${a.emptyPatches} | ${sec(a.meanDurationMs)} |`,
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
