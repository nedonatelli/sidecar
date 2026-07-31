import { describe, it } from 'vitest';
import { AGENT_CASES } from './agentCases.js';
import { CODE_QUALITY_CASES } from './codeQualityCases.js';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import type { AgentEvalCase } from './agentTypes.js';
import { summarizeAblation, formatAblationReport, type AblationRun } from '../../src/agent/ablation.js';

// ---------------------------------------------------------------------------
// Scaffold ablation runner (scaffolding roadmap M2).
//
// Runs each selected case with and without a scaffold and reports the
// scaffold's LIFT (pass-rate delta) and LATENCY cost. For local-first we
// cannot assume a scaffold helps — a same-model self-check shares the model's
// blind spots — so M2 is how we prove (or cut) each scaffold on the one model
// the operator actually runs.
//
// Run with: `npm run eval:ablation` (real model — local Ollama by default).
// Narrow the matrix with the standard filters; ablation is only meaningful on
// cases that actually exercise the scaffold:
//   SIDECAR_EVAL_CASE=review-cites-real-paths npm run eval:ablation
//   SIDECAR_ABLATION_REPS=3 npm run eval:ablation   (more reps → less variance)
//   SIDECAR_ABLATION_DIMS=completionGate,analysisCritic npm run eval:ablation
// ---------------------------------------------------------------------------

interface AblationDimension {
  scaffold: string;
  /** Config when the scaffold is active. */
  present: Record<string, unknown>;
  /** Config when the scaffold is removed. */
  absent: Record<string, unknown>;
}

const ALL_DIMENSIONS: AblationDimension[] = [
  { scaffold: 'completionGate', present: { completionGateEnabled: true }, absent: { completionGateEnabled: false } },
  // The edit + analysis critics share the criticEnabled flag; default is off,
  // so "present" measures whether turning it ON lifts pass-rate.
  { scaffold: 'critic', present: { criticEnabled: true }, absent: { criticEnabled: false } },
  { scaffold: 'autoFix', present: { autoFixOnFailure: true }, absent: { autoFixOnFailure: false } },
  // S1: externalized plan + per-turn <plan_state> re-injection. Measure on
  // long-horizon cases (tag: plans) where compression fires mid-run.
  {
    scaffold: 'planExternalized',
    present: { planExternalizedEnabled: true },
    absent: { planExternalizedEnabled: false },
  },
];

const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const TAG_FILTER = process.env.SIDECAR_EVAL_TAGS?.split(',').map((s) => s.trim());
const DIM_FILTER = process.env.SIDECAR_ABLATION_DIMS?.split(',').map((s) => s.trim());
const REPS = Math.max(1, parseInt(process.env.SIDECAR_ABLATION_REPS ?? '1', 10) || 1);

/** Seed base for common random numbers. Override to re-roll a whole campaign. */
const PAIR_SEED_BASE = parseInt(process.env.SIDECAR_ABLATION_SEED_BASE ?? '1000', 10) || 1000;

// Default to the smoke set — ablating the full suite × dimensions × arms is
// hours of real-model time. The operator narrows to scaffold-relevant cases.
const ALL_CASES = [...AGENT_CASES, ...CODE_QUALITY_CASES];
const SELECTED_CASES = ALL_CASES.filter((c) => {
  if (CASE_FILTER) return CASE_FILTER.some((f) => c.id.includes(f));
  if (TAG_FILTER) return TAG_FILTER.every((t) => c.tags.includes(t));
  return c.tags.includes('smoke');
});
const DIMENSIONS = DIM_FILTER ? ALL_DIMENSIONS.filter((d) => DIM_FILTER.includes(d.scaffold)) : ALL_DIMENSIONS;

const backend = pickAgentBackend();

describe.skipIf(!backend)('llm-eval :: scaffold ablation', () => {
  const runs: AblationRun[] = [];

  for (const dim of DIMENSIONS) {
    for (const evalCase of SELECTED_CASES) {
      for (const arm of [true, false] as const) {
        const armConfig = arm ? dim.present : dim.absent;
        for (let rep = 0; rep < REPS; rep++) {
          it(`${dim.scaffold} ${arm ? 'on' : 'off'} :: ${evalCase.id}${REPS > 1 ? ` #${rep + 1}` : ''}`, async () => {
            // COMMON RANDOM NUMBERS. Both arms of a (case, rep) pair get the same
            // sampling seed, so the pair differs only in the scaffold. This is
            // variance reduction, not determinism: the two arms see different
            // prompts (that IS the treatment), so they still diverge — but they
            // diverge from the same roll of the dice. Without it, an ablation on a
            // stochastic 7B spends most of its power measuring the model's mood.
            const cased: AgentEvalCase = {
              ...evalCase,
              configOverrides: {
                ...evalCase.configOverrides,
                ...armConfig,
                agentSeed: PAIR_SEED_BASE + rep,
              } as AgentEvalCase['configOverrides'],
            };
            const result = await runAgentCase(cased, backend!);
            runs.push({
              scaffold: dim.scaffold,
              present: arm,
              caseId: evalCase.id,
              rep, // pairs the two arms — see buildPairs() in ablation.ts
              passed: result.passed,
              durationMs: result.durationMs,
              metrics: result.metrics,
            });
            if (process.env.SIDECAR_ABLATION_TRAJ === '2') {
              // Full-forensics mode: dump the entire run result per arm/rep.
              const fs = await import('node:fs');
              const os = await import('node:os');
              const dir = process.env.SIDECAR_EVAL_TRAJECTORY_DIR || os.tmpdir();
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(
                `${dir}/ablation.${dim.scaffold}.${arm ? 'on' : 'off'}.${evalCase.id}.${rep}.json`,
                JSON.stringify(result, null, 2),
              );
            }
            if (process.env.SIDECAR_ABLATION_TRAJ === '1' || process.env.SIDECAR_ABLATION_TRAJ === '2') {
              const tools = result.trajectory
                .filter((e) => e.type === 'tool_call')
                .map((e) => (e as { name: string }).name);
              console.info(`[ablation] ${dim.scaffold} ${arm ? 'on' : 'off'} ${evalCase.id} tools: ${tools.join(',')}`);
            }
            if (!result.passed) {
              // Per-run failure reasons in the log — without these, a 0% arm
              // is uninterpretable (observed: could not tell "didn't ground"
              // from "cited a fake path" after the fact).
              console.info(
                `[ablation] ${dim.scaffold} ${arm ? 'on' : 'off'} ${evalCase.id} FAILED: ${result.failures.join(' | ')}`,
              );
            }
          });
        }
      }
    }
  }

  it('ablation summary', () => {
    console.log('\n' + formatAblationReport(summarizeAblation(runs)) + '\n');
  });
});
