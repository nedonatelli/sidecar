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
