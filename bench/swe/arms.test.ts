import { describe, it, expect } from 'vitest';
import { armConfigOverrides, armDescription } from './arms.js';

describe('armConfigOverrides', () => {
  it('scaffold-on enables the shipped verification scaffolds', () => {
    const on = armConfigOverrides('scaffold-on');
    expect(on.completionGateEnabled).toBe(true);
    expect(on.autoFixOnFailure).toBe(true);
    expect(on.impactGateEnabled).toBe(true);
    expect(on.numericalContractGateEnabled).toBe(true);
  });

  it('scaffold-on ships the keep-best ratchet, because the product does (scaffolding.keepBest = true)', () => {
    // Pinned OFF here from v0.118 to 2026-09-13; four matrices measured a
    // configuration nobody ships. The base arm IS the shipped configuration.
    expect(armConfigOverrides('scaffold-on').keepBestRatchetEnabled).toBe(true);
  });

  it('scaffold-on-noratchet is the ratchet counterfactual: scaffold-on with the ratchet off', () => {
    const n = armConfigOverrides('scaffold-on-noratchet');
    expect(n.keepBestRatchetEnabled).toBe(false);
    expect({ ...n, keepBestRatchetEnabled: true }).toEqual(armConfigOverrides('scaffold-on'));
  });

  it('scaffold-off disables every verification scaffold', () => {
    const off = armConfigOverrides('scaffold-off');
    expect(off.completionGateEnabled).toBe(false);
    expect(off.autoFixOnFailure).toBe(false);
    expect(off.impactGateEnabled).toBe(false);
    expect(off.numericalContractGateEnabled).toBe(false);
    expect(off.regressionGuards).toEqual([]);
  });

  it('gate-only enables the completion gate and nothing else', () => {
    const g = armConfigOverrides('gate-only');
    expect(g.completionGateEnabled).toBe(true);
    expect(g.autoFixOnFailure).toBe(false);
  });

  it('scaffold-on-ratchet is scaffold-on plus the keep-best ratchet', () => {
    const r = armConfigOverrides('scaffold-on-ratchet');
    expect(r.keepBestRatchetEnabled).toBe(true);
    expect(r.completionGateEnabled).toBe(true);
    expect(r.autoFixOnFailure).toBe(true);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = armConfigOverrides('scaffold-on');
    a.completionGateEnabled = false;
    expect(armConfigOverrides('scaffold-on').completionGateEnabled).toBe(true);
  });

  it('describes each arm', () => {
    expect(armDescription('scaffold-on')).toContain('completion gate');
    expect(armDescription('scaffold-off')).toContain('bare loop');
    expect(armDescription('scaffold-on-ratchet')).toContain('ratchet');
    expect(armDescription('scaffold-on-noratchet')).toContain('OFF');
  });
});
