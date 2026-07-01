// ---------------------------------------------------------------------------
// Ablation arms — the config that defines "harness on" vs "harness off".
//
// These keys are real `SideCarConfig` fields (verified against
// src/config/settings.ts); the live driver merges the chosen arm's object into
// the run config. Get a key wrong and the override is a silent no-op — which
// would make the ablation meaningless — so this list is deliberately explicit
// and unit-tested for shape.
//
// IMPORTANT: only the *configurable* scaffolds are toggled here — the
// token-spending verification layer (critic, completion gate, auto-fix,
// impact/numerical gates, regression guards, adaptive intensity). The
// zero-token DETERMINISTIC control (cycle detection, burst cap, write/rewrite-
// thrash defenses, the syntax gate's detection) is not config-gated and runs in
// BOTH arms. That's intentional: the ablation measures what the verification
// scaffolding adds, holding the free control flow constant. Document this in any
// reported number.
// ---------------------------------------------------------------------------

import type { ArmName } from './types.js';

/** Config overrides applied for each arm. Plain object — merged into the run
 *  config by the live driver. Typed loosely because bench/ is standalone (it
 *  must not import the extension's SideCarConfig). */
export type ArmOverrides = Record<string, unknown>;

const SCAFFOLD_ON: ArmOverrides = {
  criticEnabled: true,
  completionGateEnabled: true,
  autoFixOnFailure: true,
  adaptiveScaffoldingEnabled: true,
  impactGateEnabled: true,
  numericalContractGateEnabled: true,
};

const SCAFFOLD_OFF: ArmOverrides = {
  criticEnabled: false,
  completionGateEnabled: false,
  autoFixOnFailure: false,
  adaptiveScaffoldingEnabled: false,
  impactGateEnabled: false,
  numericalContractGateEnabled: false,
  diagnosticsReactiveFixEnabled: false,
  regressionGuards: [],
};

// Decomposition arms: exactly one verification scaffold on, everything else off.
// Used to localize which scaffold drives a resolve delta (do-no-harm probe).
const GATE_ONLY: ArmOverrides = { ...SCAFFOLD_OFF, completionGateEnabled: true };
const CRITIC_ONLY: ArmOverrides = { ...SCAFFOLD_OFF, criticEnabled: true };

export function armConfigOverrides(arm: ArmName): ArmOverrides {
  switch (arm) {
    case 'scaffold-on':
      return { ...SCAFFOLD_ON };
    case 'gate-only':
      return { ...GATE_ONLY };
    case 'critic-only':
      return { ...CRITIC_ONLY };
    default:
      return { ...SCAFFOLD_OFF };
  }
}

/** Human-readable list of what each arm toggles, for the report header. */
export function armDescription(arm: ArmName): string {
  switch (arm) {
    case 'scaffold-on':
      return 'critic + completion gate + auto-fix + impact/numerical gates + adaptive intensity';
    case 'gate-only':
      return 'completion gate only (all other verification scaffolds off)';
    case 'critic-only':
      return 'adversarial critic only (all other verification scaffolds off)';
    default:
      return 'bare loop (verification scaffolds off; deterministic control still on)';
  }
}
