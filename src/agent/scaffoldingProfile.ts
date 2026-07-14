import type { CapabilityTier } from '../ollama/modelCapability.js';

// ---------------------------------------------------------------------------
// Capability-driven scaffolding intensity (scaffolding roadmap A2).
//
// A1 gives a model a coarse tier; A2 maps that tier to how much loop-safety
// scaffolding to apply to the ONE model the user runs (the single-model
// principle — we tune the harness, we don't swap models).
//
// v1 moves only in the LOW-RISK direction. Strong models rarely need nudging
// and can legitimately fan out more, so they RELAX (fewer reprompts, looser
// burst cap) to save latency. Weak models stall/loop more, so they get a
// slightly larger reprompt budget to recover. Cycle/repeat thresholds are
// deliberately NOT tightened for weak models — lowering them risks a
// false-positive bail on a legitimate repeated edit.
//
// These per-tier values are HYPOTHESES, not proven-good: M2's ablation harness
// is how we validate (and tune) them before `adaptiveScaffolding.enabled` is
// flipped on by default. Until then the profile is only applied when that flag
// is set; otherwise the loop reads the historical constants and behavior is
// unchanged.
// ---------------------------------------------------------------------------

export interface ScaffoldingProfile {
  /** The capability tier this profile was resolved from — lets consumers
   *  branch on weak/medium/strong directly. */
  tier: CapabilityTier;
  /** Max tool calls in one turn before the burst cap breaks the loop. */
  burstCap: number;
  /** Max action/stall reprompts before giving up nudging the model. */
  maxActionReprompts: number;
  /** Max completion-gate injections before allowing termination. */
  maxGateInjections: number;
  /**
   * D2 — whether to run the second-LLM adversarial critic. A small primary
   * makes an equally-small critic ≈ noise (and doubles cost), so weak tier
   * relies on the deterministic gate/lint/test instead.
   */
  runLlmCritic: boolean;
  /**
   * Whether plan mode offers the ask_user tool. In plan mode it is the ONLY
   * tool in the catalog, and weak models treat a lone tool as an attractor:
   * llama3.2 asked a redundant clarifying question on 3/3 plan-mode dogfood
   * runs whose prompts were fully explicit. Weak tier plans directly from
   * the prompt — the plan-approval step IS the clarification opportunity.
   * Capable tiers keep the tool for genuine ambiguity.
   */
  planModeAskUser: boolean;
  /**
   * C4 — fraction of the token budget at which context compaction fires.
   * Weak models have less effective context and stall sooner, so they compact
   * earlier; strong models hold more before paying the summarization cost.
   * Medium == the historical CONTEXT_COMPRESSION_THRESHOLD (behavior-neutral).
   */
  compressionThreshold: number;
  /**
   * S2 — how many recent turns survive summarization untouched. Weak models
   * hold less thread, so keeping more RAW turns beats a longer summary;
   * strong models tolerate deeper summarization. Medium == the historical 2.
   */
  compactionKeepRecentTurns: number;
  /**
   * S2 — cap on the generated summary. Weak models drown in long summaries
   * (the summary itself becomes noise), so theirs is tighter. Medium == the
   * historical 800.
   */
  compactionMaxSummaryChars: number;
}

/**
 * Medium tier mirrors the historical hardcoded constants
 * (MAX_TOOL_CALLS_PER_ITERATION=12, MAX_ACTION_REPROMPTS=2,
 * MAX_GATE_INJECTIONS=2, critic on, compaction at 0.7). It's the default
 * whenever adaptive scaffolding is off, so the feature ships behavior-neutral.
 */
export const DEFAULT_SCAFFOLDING_PROFILE: ScaffoldingProfile = {
  tier: 'medium',
  burstCap: 12,
  maxActionReprompts: 2,
  maxGateInjections: 2,
  runLlmCritic: true,
  planModeAskUser: true,
  compressionThreshold: 0.7,
  compactionKeepRecentTurns: 2,
  compactionMaxSummaryChars: 800,
};

const PROFILES: Record<CapabilityTier, ScaffoldingProfile> = {
  strong: {
    tier: 'strong',
    burstCap: 16,
    maxActionReprompts: 1,
    maxGateInjections: 1,
    runLlmCritic: true,
    planModeAskUser: true,
    compressionThreshold: 0.75,
    compactionKeepRecentTurns: 3,
    compactionMaxSummaryChars: 1000,
  },
  medium: { ...DEFAULT_SCAFFOLDING_PROFILE },
  weak: {
    tier: 'weak',
    burstCap: 12,
    maxActionReprompts: 3,
    maxGateInjections: 3,
    runLlmCritic: false,
    planModeAskUser: false,
    compressionThreshold: 0.6,
    compactionKeepRecentTurns: 3,
    compactionMaxSummaryChars: 500,
  },
};

/**
 * Per-knob user overrides (`sidecar.scaffolding.overrides`).
 *
 * The tier is a bundle — moving it changes six things at once. Sometimes a user
 * wants exactly one: keep the critic but raise the burst cap, or force the
 * completion gate on for a model we classified as strong. Tier overrides are too
 * blunt for that, so every trigger is individually pinnable.
 *
 * Applied LAST, on top of whatever tier was resolved (user, learned, baseline or
 * heuristic), because an explicit instruction outranks every inference.
 */
export type ScaffoldingOverrides = Partial<Omit<ScaffoldingProfile, 'tier'>>;

export function resolveScaffoldingProfile(tier: CapabilityTier, overrides?: ScaffoldingOverrides): ScaffoldingProfile {
  const base = PROFILES[tier];
  if (!overrides || Object.keys(overrides).length === 0) return base;

  // Ignore explicit `undefined`s — `getConfiguration` hands back absent keys as
  // undefined, and spreading those would blow away the tier's real values.
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return { ...base, ...defined, tier };
}
