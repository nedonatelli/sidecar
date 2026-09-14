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
// token-spending verification layer (completion gate, auto-fix,
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
  completionGateEnabled: true,
  autoFixOnFailure: true,
  adaptiveScaffoldingEnabled: true,
  impactGateEnabled: true,
  numericalContractGateEnabled: true,
  // Explicitly ON, pinned to the SHIPPED default (`sidecar.scaffolding.keepBest`
  // = true since v0.118). This arm is "the product as shipped"; every number
  // reported against it must be a measurement of that. It was pinned OFF from
  // v0.118 to 2026-09-13 so the ratchet could be isolated in a separate arm --
  // which meant four matrices (identifier orientation x2, repro-first x2, the
  // red-check gate) measured a configuration nobody ships, on the very
  // mechanism (retry-without-keeping-a-regression) whose absence explained
  // their harm. Isolation now lives in `scaffold-on-noratchet`, the
  // counterfactual, not in the base arm.
  keepBestRatchetEnabled: true,
};

const SCAFFOLD_OFF: ArmOverrides = {
  completionGateEnabled: false,
  autoFixOnFailure: false,
  adaptiveScaffoldingEnabled: false,
  impactGateEnabled: false,
  numericalContractGateEnabled: false,
  diagnosticsReactiveFixEnabled: false,
  keepBestRatchetEnabled: false,
  regressionGuards: [],
};

// Decomposition arm: exactly one verification scaffold on, everything else off.
// Used to localize which scaffold drives a resolve delta (do-no-harm probe).
const GATE_ONLY: ArmOverrides = { ...SCAFFOLD_OFF, completionGateEnabled: true };

// The ratchet's counterfactual: scaffold-on with the keep-best ratchet OFF.
// Pair it with `scaffold-on` to isolate what the ratchet does. This is the
// configuration the pre-2026-09-13 `scaffold-on` arm actually ran.
const SCAFFOLD_ON_NORATCHET: ArmOverrides = { ...SCAFFOLD_ON, keepBestRatchetEnabled: false };

// Retained for older run scripts and the ablation report's third-arm
// comparison. Now identical to `scaffold-on` (the ratchet ships on); a
// ratchet-vs-no-ratchet comparison is `scaffold-on` vs `scaffold-on-noratchet`.
const SCAFFOLD_ON_RATCHET: ArmOverrides = { ...SCAFFOLD_ON, keepBestRatchetEnabled: true };

export function armConfigOverrides(arm: ArmName): ArmOverrides {
  switch (arm) {
    case 'scaffold-on':
      return { ...SCAFFOLD_ON };
    case 'scaffold-on-ratchet':
      return { ...SCAFFOLD_ON_RATCHET };
    case 'scaffold-on-noratchet':
      return { ...SCAFFOLD_ON_NORATCHET };
    case 'gate-only':
      return { ...GATE_ONLY };
    default:
      return { ...SCAFFOLD_OFF };
  }
}

/** Human-readable list of what each arm toggles, for the report header. */
export function armDescription(arm: ArmName): string {
  switch (arm) {
    case 'scaffold-on':
      return 'completion gate + auto-fix + impact/numerical gates + adaptive intensity + keep-best ratchet (as shipped)';
    case 'scaffold-on-ratchet':
      return 'alias of scaffold-on (the keep-best ratchet ships on)';
    case 'scaffold-on-noratchet':
      return 'scaffold-on with the keep-best ratchet OFF (the ratchet counterfactual)';
    case 'gate-only':
      return 'completion gate only (all other verification scaffolds off)';
    default:
      return 'bare loop (verification scaffolds off; deterministic control still on)';
  }
}
