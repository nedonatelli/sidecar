import { describe, it, expect } from 'vitest';
import { SCAFFOLD_VERSION, describeScaffold, scaffoldLabel } from './scaffoldVersion.js';

describe('describeScaffold', () => {
  it('stamps the current scaffold version', () => {
    expect(describeScaffold({}).version).toBe(SCAFFOLD_VERSION);
  });

  it('defaults completionGate and injectionGuard ON, others OFF', () => {
    const f = describeScaffold({}).features;
    expect(f.completionGate).toBe(true);
    expect(f.injectionGuard).toBe(true);
    expect(f.critic).toBe(false);
    expect(f.keepBestRatchet).toBe(false);
    expect(f.analyticBoundsGate).toBe(false);
  });

  it('captures the ablation scaffold-off arm as bare', () => {
    const off = describeScaffold({
      completionGateEnabled: false,
      criticEnabled: false,
      autoFixOnFailure: false,
      adaptiveScaffoldingEnabled: false,
      impactGateEnabled: false,
      numericalContractGateEnabled: false,
      injectionGuardEnabled: false,
    });
    expect(Object.values(off.features).every((v) => v === false)).toBe(true);
  });

  it('captures the ablation scaffold-on arm (pre-2.0 mechanisms)', () => {
    const on = describeScaffold({
      completionGateEnabled: true,
      criticEnabled: true,
      autoFixOnFailure: true,
      adaptiveScaffoldingEnabled: true,
      impactGateEnabled: true,
      numericalContractGateEnabled: true,
    });
    expect(on.features).toMatchObject({
      completionGate: true,
      critic: true,
      autoFix: true,
      impactGate: true,
      numericalContractGate: true,
      // NOT in the arm — proves the version, not the flags, distinguishes 1.x vs 2.0
      keepBestRatchet: false,
      analyticBoundsGate: false,
    });
  });
});

describe('scaffoldLabel', () => {
  it('lists the active mechanisms', () => {
    const label = scaffoldLabel(describeScaffold({ criticEnabled: true }));
    expect(label).toContain(`scaffold ${SCAFFOLD_VERSION}`);
    expect(label).toContain('completionGate');
    expect(label).toContain('critic');
  });

  it('shows "bare" when nothing is on', () => {
    // adaptiveScaffolding defaults ON now, so "bare" means every mechanism
    // explicitly off — an EMPTY config is no longer bare.
    const label = scaffoldLabel(
      describeScaffold({
        completionGateEnabled: false,
        injectionGuardEnabled: false,
        adaptiveScaffoldingEnabled: false,
      }),
    );
    expect(label).toContain('bare');
  });
});
