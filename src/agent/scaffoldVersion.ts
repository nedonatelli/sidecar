/**
 * Scaffold versioning — make every benchmark result attributable to the exact
 * scaffold that produced it.
 *
 * The scaffold (verification stack + gates + guards + repair) evolves fast, and
 * a resolve/lift number is only meaningful if you know WHICH scaffold generated
 * it. `run.manifest.json` already pins model/seed/temp/dataset; this adds the
 * scaffold version + a snapshot of which mechanisms were actually ON, so
 * "scaffold-on = 14%" is comparable across time only when the versions match.
 *
 * ## Versioning scheme (semver for the scaffold)
 *
 * The version captures the IMPLEMENTATION behind the flags; `describeScaffold`
 * captures which flags were on. Two runs are comparable iff BOTH match. Bump per:
 *
 * - **MAJOR** (X.0.0) — a mechanism is ADDED, REMOVED, or its verification
 *   SEMANTICS change (new gate, changed gate/repair logic, changed do-no-harm
 *   behavior). Cross-MAJOR results are NOT directly comparable.
 * - **MINOR** (x.Y.0) — a new mechanism ships behind a flag (available, default
 *   OFF), or a default arm composition changes. Comparable when the active
 *   feature snapshots match.
 * - **PATCH** (x.y.Z) — tuning WITHIN a mechanism (a threshold, a reprompt
 *   string) that doesn't change which mechanisms run.
 *
 * Discipline: bumping the version AND appending to the changelog below is part
 * of the release checklist whenever a scaffold mechanism changes. The
 * human-facing registry is `docs/scaffold-versions.md`.
 *
 * ## Changelog
 * - **2.0.0** (2026-07) — verification-vertical + do-no-harm generation. Adds
 *   the keep-best ratchet (Pareto-safe scaffolding), mutation testing, the §5
 *   analytic-bound gate + property-based test synthesis, the prompt-injection
 *   guard, and strengthened tier-1 tool-call repair (raw-control-char escaping).
 *   NOTE: the new gates default OFF and are not yet in the ablation `arms.ts`
 *   `scaffold-on` set — a `scaffold-on` run at 2.0.0 measures the SAME mechanisms
 *   as 1.x unless the arm config opts them in. The version differs because the
 *   SHARED path (repair, gate internals) changed.
 * - **1.x** — pre-2026-07 baseline (completion gate, adversarial critic,
 *   auto-fix, adaptive scaffolding, impact gate, numerical-contract gate).
 */

export const SCAFFOLD_VERSION = '2.0.0';

/** Config-like shape `describeScaffold` reads — a partial SideCarConfig or an
 *  ablation arm's merged override. All optional; defaults mirror settings.ts. */
export interface ScaffoldConfigLike {
  completionGateEnabled?: boolean;
  criticEnabled?: boolean;
  autoFixOnFailure?: boolean;
  adaptiveScaffoldingEnabled?: boolean;
  impactGateEnabled?: boolean;
  numericalContractGateEnabled?: boolean;
  analyticBoundsGateEnabled?: boolean;
  keepBestRatchetEnabled?: boolean;
  injectionGuardEnabled?: boolean;
  diagnosticsReactiveFixEnabled?: boolean;
}

export interface ScaffoldDescriptor {
  version: string;
  /** Which scaffolding mechanisms were active. Order-stable for diffing. */
  features: Record<string, boolean>;
}

/** Snapshot the active scaffold from a config/arm. `completionGate` and
 *  `injectionGuard` default ON (mirroring settings.ts); the rest default OFF. */
export function describeScaffold(cfg: ScaffoldConfigLike): ScaffoldDescriptor {
  return {
    version: SCAFFOLD_VERSION,
    features: {
      completionGate: cfg.completionGateEnabled !== false,
      critic: cfg.criticEnabled === true,
      autoFix: cfg.autoFixOnFailure === true,
      adaptiveScaffolding: cfg.adaptiveScaffoldingEnabled === true,
      impactGate: cfg.impactGateEnabled === true,
      numericalContractGate: cfg.numericalContractGateEnabled === true,
      analyticBoundsGate: cfg.analyticBoundsGateEnabled === true,
      keepBestRatchet: cfg.keepBestRatchetEnabled === true,
      injectionGuard: cfg.injectionGuardEnabled !== false,
      diagnosticsReactiveFix: cfg.diagnosticsReactiveFixEnabled === true,
    },
  };
}

/** Compact one-line label, e.g. `scaffold 2.0.0 [completionGate,critic,autoFix]`. */
export function scaffoldLabel(desc: ScaffoldDescriptor): string {
  const on = Object.entries(desc.features)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return `scaffold ${desc.version} [${on.join(',') || 'bare'}]`;
}
