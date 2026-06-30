import { describe, it, expect } from 'vitest';
import { armConfigOverrides, armDescription } from './arms.js';

describe('armConfigOverrides', () => {
  it('scaffold-on enables the verification scaffolds', () => {
    const on = armConfigOverrides('scaffold-on');
    expect(on.criticEnabled).toBe(true);
    expect(on.completionGateEnabled).toBe(true);
    expect(on.autoFixOnFailure).toBe(true);
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

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = armConfigOverrides('scaffold-on');
    a.criticEnabled = false;
    expect(armConfigOverrides('scaffold-on').criticEnabled).toBe(true);
  });

  it('describes each arm', () => {
    expect(armDescription('scaffold-on')).toContain('critic');
    expect(armDescription('scaffold-off')).toContain('bare loop');
  });
});
