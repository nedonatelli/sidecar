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
  /** Max tool calls in one turn before the burst cap breaks the loop. */
  burstCap: number;
  /** Max action/stall reprompts before giving up nudging the model. */
  maxActionReprompts: number;
  /** Max completion-gate injections before allowing termination. */
  maxGateInjections: number;
}

/**
 * Medium tier mirrors the historical hardcoded constants
 * (MAX_TOOL_CALLS_PER_ITERATION=12, MAX_ACTION_REPROMPTS=2,
 * MAX_GATE_INJECTIONS=2). It's the default whenever adaptive scaffolding is
 * off, so the feature ships behavior-neutral.
 */
export const DEFAULT_SCAFFOLDING_PROFILE: ScaffoldingProfile = {
  burstCap: 12,
  maxActionReprompts: 2,
  maxGateInjections: 2,
};

const PROFILES: Record<CapabilityTier, ScaffoldingProfile> = {
  strong: { burstCap: 16, maxActionReprompts: 1, maxGateInjections: 1 },
  medium: { ...DEFAULT_SCAFFOLDING_PROFILE },
  weak: { burstCap: 12, maxActionReprompts: 3, maxGateInjections: 3 },
};

export function resolveScaffoldingProfile(tier: CapabilityTier): ScaffoldingProfile {
  return PROFILES[tier];
}
