import { describe, it, expect } from 'vitest';
import { resolveScaffoldingProfile, DEFAULT_SCAFFOLDING_PROFILE } from './scaffoldingProfile.js';

describe('resolveScaffoldingProfile', () => {
  it('medium tier equals the historical defaults (behavior-neutral)', () => {
    expect(resolveScaffoldingProfile('medium')).toEqual(DEFAULT_SCAFFOLDING_PROFILE);
  });

  it('strong tier relaxes: fewer reprompts, looser burst cap', () => {
    const p = resolveScaffoldingProfile('strong');
    expect(p.maxActionReprompts).toBeLessThan(DEFAULT_SCAFFOLDING_PROFILE.maxActionReprompts);
    expect(p.maxGateInjections).toBeLessThan(DEFAULT_SCAFFOLDING_PROFILE.maxGateInjections);
    expect(p.burstCap).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.burstCap);
  });

  it('weak tier widens the reprompt budget but keeps the burst cap (no double-edged tightening)', () => {
    const p = resolveScaffoldingProfile('weak');
    expect(p.maxActionReprompts).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.maxActionReprompts);
    expect(p.maxGateInjections).toBeGreaterThan(DEFAULT_SCAFFOLDING_PROFILE.maxGateInjections);
    expect(p.burstCap).toBe(DEFAULT_SCAFFOLDING_PROFILE.burstCap);
  });

  it('S2 compaction shape: medium mirrors the historical constants; weak keeps more raw turns with a tighter summary; strong summarizes deeper', () => {
    const medium = resolveScaffoldingProfile('medium');
    expect(medium.compactionKeepRecentTurns).toBe(2);
    expect(medium.compactionMaxSummaryChars).toBe(800);
    const weak = resolveScaffoldingProfile('weak');
    expect(weak.compactionKeepRecentTurns).toBeGreaterThan(medium.compactionKeepRecentTurns);
    expect(weak.compactionMaxSummaryChars).toBeLessThan(medium.compactionMaxSummaryChars);
    const strong = resolveScaffoldingProfile('strong');
    expect(strong.compactionMaxSummaryChars).toBeGreaterThanOrEqual(medium.compactionMaxSummaryChars);
  });

  it('carries its tier and the tier-awareness knobs (D2/C4)', () => {
    expect(resolveScaffoldingProfile('weak').tier).toBe('weak');
    expect(resolveScaffoldingProfile('strong').tier).toBe('strong');

    // D2 — weak primary skips the LLM critic; medium/strong keep it.
    expect(resolveScaffoldingProfile('weak').runLlmCritic).toBe(false);
    expect(resolveScaffoldingProfile('medium').runLlmCritic).toBe(true);
    expect(resolveScaffoldingProfile('strong').runLlmCritic).toBe(true);

    // C4 — weak compacts earlier, strong later; medium == historical 0.7.
    expect(resolveScaffoldingProfile('weak').compressionThreshold).toBeLessThan(
      resolveScaffoldingProfile('medium').compressionThreshold,
    );
    expect(resolveScaffoldingProfile('strong').compressionThreshold).toBeGreaterThan(
      resolveScaffoldingProfile('medium').compressionThreshold,
    );
    expect(DEFAULT_SCAFFOLDING_PROFILE.compressionThreshold).toBe(0.7);
  });
});

describe('planModeAskUser (weak-tier plan-mode tool attractor)', () => {
  it('weak tier plans without ask_user; medium/strong keep it', () => {
    expect(resolveScaffoldingProfile('weak').planModeAskUser).toBe(false);
    expect(resolveScaffoldingProfile('medium').planModeAskUser).toBe(true);
    expect(resolveScaffoldingProfile('strong').planModeAskUser).toBe(true);
  });

  it('the behavior-neutral default (adaptive scaffolding off) keeps ask_user', () => {
    expect(DEFAULT_SCAFFOLDING_PROFILE.planModeAskUser).toBe(true);
  });
});
