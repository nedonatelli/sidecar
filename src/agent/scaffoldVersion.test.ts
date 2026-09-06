import { describe, it, expect } from 'vitest';
import { SCAFFOLD_VERSION, describeScaffold, scaffoldLabel } from './scaffoldVersion.js';

describe('describeScaffold', () => {
  it('stamps the current scaffold version', () => {
    expect(describeScaffold({}).version).toBe(SCAFFOLD_VERSION);
  });

  it('defaults completionGate, injectionGuard, adaptiveScaffolding and keepBestRatchet ON, others OFF', () => {
    // Mirrors settings.ts defaults — keepBest flipped default-on in v0.118
    // (scaffold 2.1.0). An absent field must stamp the settings default, or
    // a run manifest misreports the scaffold that actually ran.
    const f = describeScaffold({}).features;
    expect(f.completionGate).toBe(true);
    expect(f.injectionGuard).toBe(true);
    expect(f.adaptiveScaffolding).toBe(true);
    expect(f.keepBestRatchet).toBe(true);
    expect(f.analyticBoundsGate).toBe(false);
  });

  it('captures the ablation scaffold-off arm as bare', () => {
    // A bare arm must set every default-ON mechanism to false explicitly —
    // absence means "settings default", not "off".
    const off = describeScaffold({
      completionGateEnabled: false,
      autoFixOnFailure: false,
      adaptiveScaffoldingEnabled: false,
      impactGateEnabled: false,
      numericalContractGateEnabled: false,
      injectionGuardEnabled: false,
      keepBestRatchetEnabled: false,
    });
    expect(Object.values(off.features).every((v) => v === false)).toBe(true);
  });

  it('captures the ablation scaffold-on arm (pre-2.0 mechanisms)', () => {
    const on = describeScaffold({
      completionGateEnabled: true,
      autoFixOnFailure: true,
      adaptiveScaffoldingEnabled: true,
      impactGateEnabled: true,
      numericalContractGateEnabled: true,
      // Excluded from the pre-2.0 arm explicitly — absence now means
      // "settings default" (ON since v0.118), not "off".
      keepBestRatchetEnabled: false,
    });
    expect(on.features).toMatchObject({
      completionGate: true,
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
    const label = scaffoldLabel(describeScaffold({ autoFixOnFailure: true }));
    expect(label).toContain(`scaffold ${SCAFFOLD_VERSION}`);
    expect(label).toContain('completionGate');
    expect(label).toContain('autoFix');
  });

  it('shows "bare" when nothing is on', () => {
    // adaptiveScaffolding and keepBestRatchet default ON now, so "bare"
    // means every mechanism explicitly off — an EMPTY config is not bare.
    const label = scaffoldLabel(
      describeScaffold({
        completionGateEnabled: false,
        injectionGuardEnabled: false,
        adaptiveScaffoldingEnabled: false,
        keepBestRatchetEnabled: false,
      }),
    );
    expect(label).toContain('bare');
  });
});
