import { describe, it } from 'vitest';
import { AGENT_CASES } from './agentCases.js';
import { runAgentCase, pickAgentBackend } from './agentHarness.js';
import type { AgentEvalCase } from './agentTypes.js';
import { contrastAllArms, renderArmContrasts, type ArmedRun } from '../../src/agent/ablationStats.js';

// ---------------------------------------------------------------------------
// Whole-harness ablation: bare vs always-on vs dynamic.
//
// The existing ablation.eval.ts toggles ONE scaffold at a time — useful for
// pruning an individual guard, useless for the question SideCar actually stakes
// its design on: does adapting the harness per model beat picking one setting?
// That needs the three whole-harness arms, on the same cases, with the same seeds.
//
//   bare      — verification scaffolding off. The floor.
//   always-on — every guard on, fixed, for every model. The naive maximum.
//   dynamic   — tier-driven, chosen from the model's measured capability. Default.
//
// HONEST BOUND ON "BARE": it is not a naked model. The structural layer — tool-call
// repair, the example-replay guard, escalating bounces, text-form parsing — is not
// flag-gated and runs in every arm. Without it, weak models cannot emit a usable
// tool call at all and every arm would collapse to zero, measuring nothing. So the
// claim this can support is "does the VERIFICATION scaffolding earn its keep",
// not "is the harness worth anything at all". Overstating that would be the same
// error as reporting a lift with no discordant pairs.
//
// Run:
//   SIDECAR_ARMS_REPS=13 SIDECAR_EVAL_MODEL=qwen2.5-coder:7b \
//     npx vitest run --config vitest.eval.config.ts tests/llm-eval/armsAblation.eval.ts
//
// Pick REPS from the reliability baseline: a case with pass rate p yields
// discordant pairs at 2p(1−p) per rep, and six discordant pairs are needed before
// significance is even arithmetically reachable. planAblationCampaign() prints the
// number. Saturated cases (always/never pass) are excluded below — they cannot
// inform this at ANY sample size.
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();

/** Every verification scaffold off. */
const BARE = {
  completionGateEnabled: false,
  autoFixOnFailure: false,
  adaptiveScaffoldingEnabled: false,
  keepBestRatchetEnabled: false,
  impactGateEnabled: false,
  numericalContractGateEnabled: false,
  analyticBoundsGateEnabled: false,
  planExternalizedEnabled: false,
  diagnosticsReactiveFixEnabled: false,
};

/** Everything on, fixed — the same maximum for every model, no adaptation. */
const ALWAYS_ON = {
  completionGateEnabled: true,
  autoFixOnFailure: true,
  adaptiveScaffoldingEnabled: false, // fixed medium profile — the point of the contrast
  keepBestRatchetEnabled: true,
  impactGateEnabled: true,
  numericalContractGateEnabled: true,
  analyticBoundsGateEnabled: true,
  planExternalizedEnabled: true,
  diagnosticsReactiveFixEnabled: true,
};

/** The shipped default: same guards, but their intensity is chosen per model. */
const DYNAMIC = { ...ALWAYS_ON, adaptiveScaffoldingEnabled: true, modelLearningEnabled: true };

const ARMS = [
  { name: 'bare', config: BARE },
  { name: 'always-on', config: ALWAYS_ON },
  { name: 'dynamic', config: DYNAMIC },
] as const;

const REPS = Math.max(1, parseInt(process.env.SIDECAR_ARMS_REPS ?? '13', 10) || 13);
const SEED_BASE = parseInt(process.env.SIDECAR_ARMS_SEED_BASE ?? '7000', 10) || 7000;

// Only cases that can actually go either way. A saturated case passes (or fails) in
// every arm, contributes only concordant pairs, and burns GPU to say nothing.
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const CASES = AGENT_CASES.filter((c) => (CASE_FILTER ? CASE_FILTER.includes(c.id) : c.tags.includes('smoke')));

describe.skipIf(!backend)('llm-eval :: whole-harness arms', () => {
  const runs: ArmedRun[] = [];

  for (const evalCase of CASES) {
    for (let rep = 0; rep < REPS; rep++) {
      for (const arm of ARMS) {
        it(`${arm.name} :: ${evalCase.id} #${rep + 1}`, async () => {
          const cased: AgentEvalCase = {
            ...evalCase,
            configOverrides: {
              ...evalCase.configOverrides,
              ...arm.config,
              // COMMON RANDOM NUMBERS: all three arms of a (case, rep) share a seed,
              // so they diverge from the same roll of the dice. The arms still differ
              // — different prompts ARE the treatment — but the model's mood cancels,
              // which is most of the variance on a stochastic local model.
              agentSeed: SEED_BASE + rep,
            } as AgentEvalCase['configOverrides'],
          };
          const result = await runAgentCase(cased, backend!);
          runs.push({ arm: arm.name, caseId: evalCase.id, rep, passed: result.passed });
        });
      }
    }
  }

  it('contrasts', () => {
    const contrasts = contrastAllArms(
      runs,
      ARMS.map((a) => a.name),
    );
    console.log('\n\n' + renderArmContrasts(contrasts) + '\n');
  });
});
