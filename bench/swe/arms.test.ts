import { describe, it, expect } from 'vitest';
import { armConfigOverrides, armDescription } from './arms.js';

describe('armConfigOverrides', () => {
  it('scaffold-on enables the shipped verification scaffolds but NOT the critic', () => {
    const on = armConfigOverrides('scaffold-on');
    // Critic ships default-off (measured actively harmful); scaffold-on must
    // represent the real product, so the critic stays off here. critic-only
    // isolates it.
    expect(on.criticEnabled).toBe(false);
    expect(on.completionGateEnabled).toBe(true);
    expect(on.autoFixOnFailure).toBe(true);
    expect(on.impactGateEnabled).toBe(true);
    expect(on.numericalContractGateEnabled).toBe(true);
  });

  it('scaffold-off disables every verification scaffold', () => {
    const off = armConfigOverrides('scaffold-off');
    expect(off.criticEnabled).toBe(false);
    expect(off.completionGateEnabled).toBe(false);
    expect(off.autoFixOnFailure).toBe(false);
    expect(off.impactGateEnabled).toBe(false);
    expect(off.numericalContractGateEnabled).toBe(false);
    expect(off.regressionGuards).toEqual([]);
  });

  it('gate-only enables the completion gate and nothing else', () => {
    const g = armConfigOverrides('gate-only');
    expect(g.completionGateEnabled).toBe(true);
    expect(g.criticEnabled).toBe(false);
    expect(g.autoFixOnFailure).toBe(false);
  });

  it('critic-only enables the critic and nothing else', () => {
    const c = armConfigOverrides('critic-only');
    expect(c.criticEnabled).toBe(true);
    expect(c.completionGateEnabled).toBe(false);
    expect(c.autoFixOnFailure).toBe(false);
  });

  it('scaffold-on-ratchet is scaffold-on plus the keep-best ratchet', () => {
    const r = armConfigOverrides('scaffold-on-ratchet');
    expect(r.keepBestRatchetEnabled).toBe(true);
    expect(r.criticEnabled).toBe(false); // inherits scaffold-on's (deliberately off) critic
    expect(r.completionGateEnabled).toBe(true);
    expect(r.autoFixOnFailure).toBe(true);
  });

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = armConfigOverrides('scaffold-on');
    a.completionGateEnabled = false;
    expect(armConfigOverrides('scaffold-on').completionGateEnabled).toBe(true);
  });

  it('describes each arm', () => {
    expect(armDescription('scaffold-on')).toContain('critic');
    expect(armDescription('scaffold-off')).toContain('bare loop');
    expect(armDescription('scaffold-on-ratchet')).toContain('ratchet');
  });
});
