import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planAblationCampaign } from '../../src/agent/ablationStats.js';

// ---------------------------------------------------------------------------
// Cross-model reliability matrix — "what should we work on?"
//
// Reads the per-model baselines written by `SIDECAR_RELIABILITY_OUT` (see
// scripts/reliability-sweep.sh) and renders two things no single-model run can
// show:
//
//   1. WHERE EACH MODEL IS WEAK. A case at 100% for gemma4 and 40% for llama3.2
//      is not a suite problem, it is a llama problem — and it names the work.
//      A case that is low for EVERY model is a SideCar problem: the scaffolding
//      is failing all of them, and that is the highest-value thing on the board.
//
//   2. WHERE AN ABLATION CAN SEE ANYTHING, per model. A scaffold can only flip an
//      outcome that could have gone either way, so the informative cases are the
//      ones near a coin flip — and which cases those ARE differs per model. That
//      is exactly the claim adaptive scaffolding makes (weak models need guards
//      that strong models do not) and it has never had to prove it. This report
//      is how it would.
//
// Costs no model time — it only aggregates. Run it after a sweep:
//
//   ./scripts/reliability-sweep.sh
//   npx vitest run --config vitest.eval.config.ts tests/llm-eval/reliabilityReport.eval.ts
// ---------------------------------------------------------------------------

interface Baseline {
  model: string;
  trials: number;
  rows: { caseId: string; trials: number; passes: number }[];
}

const DIR = process.env.SIDECAR_RELIABILITY_DIR || '.sidecar/logs/reliability';

function loadBaselines(): Baseline[] {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8')) as Baseline)
    .sort((a, b) => a.model.localeCompare(b.model));
}

const pct = (k: number, n: number) => (n === 0 ? '—' : `${Math.round((k / n) * 100)}%`);

describe('cross-model reliability matrix', () => {
  it('renders the matrix and the per-model ablation plan', () => {
    const baselines = loadBaselines();
    if (baselines.length === 0) {
      console.log(`\nNo baselines in ${DIR}. Run ./scripts/reliability-sweep.sh first.`);
      return;
    }

    const caseIds = [...new Set(baselines.flatMap((b) => b.rows.map((r) => r.caseId)))].sort();
    const rateOf = (b: Baseline, caseId: string): { passes: number; trials: number } | null => {
      const row = b.rows.find((r) => r.caseId === caseId);
      return row ? { passes: row.passes, trials: row.trials } : null;
    };

    const lines: string[] = [];
    lines.push('# Cross-model reliability');
    lines.push('');
    lines.push(`Trials per case: ${baselines.map((b) => `${b.model}=${b.trials}`).join(', ')}`);
    lines.push('');
    lines.push(`| case | ${baselines.map((b) => b.model).join(' | ')} |`);
    lines.push(`|---|${baselines.map(() => '---').join('|')}|`);

    for (const caseId of caseIds) {
      const cells = baselines.map((b) => {
        const r = rateOf(b, caseId);
        return r ? pct(r.passes, r.trials) : '—';
      });
      lines.push(`| ${caseId} | ${cells.join(' | ')} |`);
    }

    // A case every model struggles with is OUR bug, not the models'. That is the
    // single most useful line in this report.
    lines.push('');
    const universallyWeak = caseIds.filter((caseId) =>
      baselines.every((b) => {
        const r = rateOf(b, caseId);
        return r !== null && r.trials > 0 && r.passes / r.trials < 0.7;
      }),
    );
    lines.push(
      universallyWeak.length > 0
        ? `**Weak across EVERY model → a SideCar problem, not a model problem:** ${universallyWeak.join(', ')}`
        : '**No case is weak across every model** — remaining failures are model-specific.',
    );

    // Per-model: which cases can an ablation actually learn from?
    for (const b of baselines) {
      const plan = planAblationCampaign(b.rows);
      const usable = plan.filter((c) => c.usable);
      lines.push('');
      lines.push(`## ${b.model} — ablation plan`);
      if (usable.length === 0) {
        lines.push('  Every case is saturated (always or never passes). An ablation here can see NOTHING,');
        lines.push('  at any sample size. Pick harder or easier cases before spending GPU on it.');
        continue;
      }
      for (const c of usable) {
        lines.push(
          `  ${c.caseId.padEnd(30)} ${(c.passRate * 100).toFixed(0).padStart(3)}%  ` +
            `→ ${String(c.requiredReps).padStart(3)} reps for a conclusive result`,
        );
      }
      const dead = plan.filter((c) => !c.usable).map((c) => c.caseId);
      if (dead.length > 0) lines.push(`  (saturated, cannot inform an ablation: ${dead.join(', ')})`);
    }

    console.log('\n' + lines.join('\n') + '\n');
  });
});
