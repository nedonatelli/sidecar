// Measured starting tiers for models we have actually tested.
//
// The name heuristic (`parseParamSizeB`) is a guess, and on local models it is
// usually a bad one: it reads `qwen2.5-coder:7b` as a 7B model and files it
// under `weak`, and it cannot parse `qwen3.5:latest` at all so it files THAT
// under "unknown → conservative default" — also `weak`. Both score 5/5 on the
// dogfood suite. Meanwhile llama3.2, which genuinely is weak, lands in the same
// bucket. A classifier that puts the best and worst local models in one tier is
// not classifying anything.
//
// So for models we have run the suites against, the tier is a MEASUREMENT, and
// it is recorded here as the cold-start prior. This is the difference between
// "we think a 7B model is probably weak" and "we ran it thirty times".
//
// ## Precedence
//
// This table is a PRIOR, not a verdict. It ranks below what the model does in
// the user's own workspace (`modelPerformance.ts` adjusts from here) and far
// below an explicit user override — our numbers come from our repos and our
// tasks, which are not theirs. It exists to kill the cold start, so a known-good
// model isn't treated as untrustworthy for its first ten runs.
//
// ## Keeping it honest
//
// Every entry cites what it was measured on and when. An entry with no
// measurement behind it does not belong here — the whole point of this file is
// that it is not guessing. Re-measure with:
//
//     SIDECAR_EVAL_TAGS=dogfood SIDECAR_EVAL_MODEL=<model> \
//       npx vitest run --config vitest.eval.config.ts tests/llm-eval/agent.eval.ts

import type { CapabilityTier } from '../ollama/modelCapability.js';

export interface ModelBaseline {
  tier: CapabilityTier;
  /** What this tier is based on. Shown in the capability profile's reasons. */
  evidence: string;
}

/**
 * Keys are matched against the model id case-insensitively, first by exact match
 * and then by prefix, so `qwen2.5-coder:7b-instruct-q4_K_M` inherits the
 * `qwen2.5-coder:7b` baseline rather than falling back to the name heuristic.
 */
const BASELINES: Record<string, ModelBaseline> = {
  // 5/5 dogfood (2026-07, scaffold 3.0.0). Reliable tool-caller and the eval
  // baseline model — but it PASSES add-jsdoc only because the action reprompt
  // pulls it back after it narrates the edit instead of making it. It uses the
  // scaffolding, so it does not get less of it. Medium, not strong.
  'qwen2.5-coder:7b': { tier: 'medium', evidence: '5/5 dogfood (2026-07) — uses the scaffolding it is given' },
  'qwen2.5-coder:14b': { tier: 'medium', evidence: 'larger sibling of the 5/5 dogfood baseline (2026-07)' },

  // 5/5 dogfood (2026-07). The name has no parseable size, so the heuristic
  // filed it as "unknown local model" → weak. It is not weak.
  'qwen3.5': { tier: 'medium', evidence: '5/5 dogfood (2026-07); 96% prompt / 67% agent eval' },

  // 5/5 dogfood (2026-07) and 95% on the BFCL AST subset — the strongest local
  // tool-caller measured, beating qwen2.5-coder:7b (78%) on BFCL.
  'gemma4:e4b': { tier: 'medium', evidence: '5/5 dogfood (2026-07); 95% BFCL AST' },

  // 4/5 dogfood (2026-07) — competent, one failure.
  'granite4.1:3b': { tier: 'weak', evidence: '4/5 dogfood (2026-07) — 3B, needs the guards' },
  'ministral-3': { tier: 'weak', evidence: '4/5 dogfood (2026-07)' },

  // 2/5 dogfood (2026-07). Genuinely weak: sends nonsense search/replace pairs
  // (`search: "function step47("`, `replace: "* 47"`), replays tool-description
  // examples verbatim, and has contradicted its own tool output ("the rename did
  // not land" about a file plainly containing the rename). Keep every guard.
  'llama3.2': { tier: 'weak', evidence: '2/5 dogfood (2026-07) — malformed edits, example replay' },

  // Larger local coders. Not yet swept; listed only where size makes the
  // heuristic's `weak` verdict clearly wrong.
  'qwen3-coder:30b': { tier: 'medium', evidence: '30B local coder — heuristic tier, not yet swept' },
  'devstral:24b': { tier: 'medium', evidence: '24B local coder — heuristic tier, not yet swept' },
};

/**
 * The measured baseline for `model`, or null when we have never tested it.
 * Exact match first, then longest-prefix, so quantization and instruct suffixes
 * inherit their base model's measurement.
 */
export function getModelBaseline(model: string): ModelBaseline | null {
  const id = model.toLowerCase();
  if (BASELINES[id]) return BASELINES[id];

  let best: { key: string; baseline: ModelBaseline } | null = null;
  for (const [key, baseline] of Object.entries(BASELINES)) {
    if (!id.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, baseline };
  }
  return best?.baseline ?? null;
}
