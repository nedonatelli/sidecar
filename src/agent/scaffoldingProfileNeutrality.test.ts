import { describe, it, expect } from 'vitest';
import { resolveScaffoldingProfile, DEFAULT_SCAFFOLDING_PROFILE } from './scaffoldingProfile.js';
import {
  MAX_TOOL_CALLS_PER_ITERATION,
  MAX_ACTION_REPROMPTS,
  MAX_GATE_INJECTIONS,
  CONTEXT_COMPRESSION_THRESHOLD,
  COMPACTION_KEEP_RECENT_TURNS,
  COMPACTION_MAX_SUMMARY_CHARS,
} from '../config/constants.js';

// ---------------------------------------------------------------------------
// The medium tier must remain EXACTLY the loop's fallback behavior.
//
// This is the assumption that lets `sidecar.adaptiveScaffolding.enabled` ship
// default-ON without changing anything for a medium-tier model: when no profile
// is resolved, every call site reads `scaffoldingProfile?.X ?? CONSTANT`, so
// medium == the constants means "flag on" and "flag off" are the same run.
//
// It is not a nice-to-have. If a knob drifts, flipping the default silently
// changes behavior for every medium model — qwen2.5-coder, qwen3.5, gemma4, and
// any model a user pins there — with no test failing and no changelog entry.
//
// The constants now live in one place and the profile is built from them, so
// this can only break if someone deliberately edits the medium tier. Which is
// allowed! But it means the default flip is no longer neutral, and that has to
// be a conscious act with a SCAFFOLD_VERSION bump, not a silent one.
// ---------------------------------------------------------------------------

describe('medium tier === the loop’s fallback constants', () => {
  it('every knob matches the constant its call site falls back to', () => {
    expect(DEFAULT_SCAFFOLDING_PROFILE).toEqual({
      tier: 'medium',
      burstCap: MAX_TOOL_CALLS_PER_ITERATION,
      maxActionReprompts: MAX_ACTION_REPROMPTS,
      maxGateInjections: MAX_GATE_INJECTIONS,
      planModeAskUser: true,
      compressionThreshold: CONTEXT_COMPRESSION_THRESHOLD,
      compactionKeepRecentTurns: COMPACTION_KEEP_RECENT_TURNS,
      compactionMaxSummaryChars: COMPACTION_MAX_SUMMARY_CHARS,
    });
  });

  it('resolving the medium tier is identical to resolving nothing at all', () => {
    expect(resolveScaffoldingProfile('medium')).toEqual(DEFAULT_SCAFFOLDING_PROFILE);
  });

  it('planModeAskUser stays true — only an explicit `false` strips ask_user', () => {
    // The call site reads `profile?.planModeAskUser === false ? [] : [ask_user]`,
    // so `true` and "no profile" behave the same. Pinned because a change to
    // `undefined` here would read as harmless and would silently remove the tool.
    expect(resolveScaffoldingProfile('medium').planModeAskUser).toBe(true);
  });
});

describe('the tiers that DO differ — the flip’s actual risk surface', () => {
  // Flipping the default only changes behavior for weak and strong. These
  // assertions exist so that surface is explicit and cannot grow unnoticed.
  it('weak adds recovery budget; its two suppressions are both evidenced', () => {
    const weak = resolveScaffoldingProfile('weak');
    expect(weak.maxActionReprompts).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.maxActionReprompts);
    expect(weak.maxGateInjections).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.maxGateInjections);

    // This one IS a real removal, and the only one the flip makes by default.
    // In plan mode ask_user is the ONLY tool in the catalog, and weak models
    // treat a lone tool as an attractor: llama3.2 asked a redundant clarifying
    // question on 3/3 plan-mode runs whose prompts were already fully explicit.
    // The plan-approval step is itself the clarification opportunity.
    expect(weak.planModeAskUser).toBe(false);
  });

  it('strong NEVER cuts the verification budget — it only relaxes latency knobs', () => {
    const strong = resolveScaffoldingProfile('strong');

    // Latency wins: a capable model handles a bigger burst and holds more context.
    expect(strong.burstCap).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.burstCap);
    expect(strong.compressionThreshold).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.compressionThreshold);

    // Verification budgets stay at parity. Both of these were 1 — halved on the
    // theory that frontier models rarely need a second attempt. Measured against
    // claude-sonnet-5 (dogfood, 2 trials, both arms), the theory did not hold:
    //
    //   • The action reprompt fired in 10/10 runs. Sonnet narrates an edit instead
    //     of making it at least once per task, exactly like the local models. At a
    //     budget of 1 it spends 100% of it every run — permanently at the ceiling.
    //   • The completion gate injected 0 times in both arms, so the 2→1 cut was
    //     never exercised at all. Absence of evidence, not evidence of safety.
    //
    // A capable model earns lower latency. It does not earn less verification.
    expect(strong.maxActionReprompts).toBe(DEFAULT_SCAFFOLDING_PROFILE.maxActionReprompts);
    expect(strong.maxGateInjections).toBe(DEFAULT_SCAFFOLDING_PROFILE.maxGateInjections);
  });
});
