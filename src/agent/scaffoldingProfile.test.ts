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
});
