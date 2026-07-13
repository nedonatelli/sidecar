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
 * - **3.0.0** (2026-07) — always-on dispatch guards + text-repair expansion.
 *   Adds the example-replay guard (executor bounces tool calls whose arguments
 *   verbatim-match the example in that tool's own description — no flag,
 *   always on, restricted to examples with ≥2 arguments so legitimate
 *   single-key calls can't collide by coincidence) and escalating
 *   dispatch-bounce messages (2nd consecutive
 *   identical bounce: "do not resubmit"; 3rd+: "stop retrying, change
 *   approach"; streaks reset on any successful call). textParsing's bare-JSON
 *   path now recognizes the OpenAI function-call shape
 *   ({"type":"function","function":{name,parameters}}) and salvages
 *   truncated emissions missing their closing brace (both observed live from
 *   llama3.2 — calls that previously dropped silently now dispatch). MAJOR:
 *   the shared dispatch/repair path changed; a model's measured resolve rate
 *   is not comparable across this boundary (llama3.2-class models gain
 *   previously-lost tool calls).
 * - **2.0.1** (2026-07) — keep-best ratchet's over-engineering threshold
 *   (`DEFAULT_OVER_ENGINEER_BYTES`) tightened from 4096 to 0. A local SWE-bench
 *   repro of scaffold-on bail-early found a concrete case (a 536-byte wrong edit
 *   to an unrelated file, driven by a cycle-detection bail) that slid under the
 *   old 4 KB threshold untouched. A byte-size gate alone can't distinguish a
 *   legitimate small addition from a wrong one, so the default now reverts ANY
 *   scaffold-tail growth that didn't earn a proven test-signal improvement.
 *   PATCH-level: tunes a threshold within the existing ratchet, doesn't add,
 *   remove, or change which mechanisms run.
 * - **2.1.0** (2026-07) — keep-best ratchet DEFAULT-ON. `scaffolding.keepBest`
 *   flips to true: the default harness now snapshots at the scaffold boundary
 *   and reverts unproven scaffold-tail changes at termination. MINOR: changes
 *   which mechanisms run by default (evidence: 150-run 3-arm SWE campaign —
 *   over-engineering 36.6→29.6KB mean patch, 6/50 reverts, do-no-harm clean;
 *   resolve non-regression vacuous at 7B/Verified, re-verify on a resolvable
 *   class — see Prove-or-Prune Ledger).
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

export const SCAFFOLD_VERSION = '3.0.0';

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
