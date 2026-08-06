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
 * - **3.1.0** (2026-07) — adaptive scaffolding ON by default, and capability
 *   tiers learned from measured performance rather than parsed from the model's
 *   filename. MINOR: the default arm composition changed, so runs either side of
 *   this boundary are comparable only when their per-arm feature snapshots match.
 *   The `medium` tier is provably identical to the historical constants (it is now
 *   BUILT from them — see scaffoldingProfileNeutrality.test.ts), so the flip is a
 *   no-op for a medium model. `weak` measured flat across llama3.2 / ministral-3 /
 *   granite4.1 (dogfood, 2 trials, both arms — not one case moved). `strong` had
 *   its verification budgets RESTORED to parity with medium (maxActionReprompts
 *   and maxGateInjections were 1, now 2): against claude-sonnet-5 the action
 *   reprompt fired in 10/10 runs — a frontier model narrates instead of acting at
 *   least once per task — so a budget of 1 runs permanently at its ceiling; and the
 *   completion gate injected 0 times, so the cut was never exercised at all. Strong
 *   keeps only the latency relaxations (burst cap, compression threshold).
 * - **3.0.0** (2026-07) — always-on dispatch guards + edit recovery + text repair.
 *   Adds the example-replay guard (executor bounces tool calls whose arguments
 *   verbatim-match the example in that tool's own description — no flag,
 *   always on, restricted to examples with ≥2 arguments so legitimate
 *   single-key calls can't collide by coincidence) and escalating
 *   dispatch-bounce messages (2nd consecutive
 *   identical bounce: "do not resubmit"; 3rd+: "stop retrying, change
 *   approach"; streaks reset on any successful call). textParsing's bare-JSON
 *   path now recognizes the OpenAI function-call shape
 *   ({"type":"function","function":{name,parameters}}), salvages
 *   truncated emissions missing their closing brace, and counts braces
 *   string-aware (a `{` inside a JSON string value used to run the depth off,
 *   delivering a well-formed rename as `edit_file({})`). edit_file gains an
 *   edit-time tree-sitter syntax guard, a Python indentation check, and
 *   two-tier intent recovery: a guessed region is APPLIED only when it beats
 *   the runner-up by ≥3 distinctive words (zero wrong in 177 commitments over
 *   1,700 real edits) and otherwise merely SUGGESTED, writing nothing. The
 *   action reprompt now fires after tool calls at all — it had been reading a
 *   tool result as "the user said nothing", so a model that narrated an edit
 *   instead of making it terminated as done. MAJOR:
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
 * - **4.0.0** (2026-07) — edit_file collapses to ONE operation. insert_before /
 *   insert_after / new_text and the V2 insert convention are removed, along with
 *   the splitFusedAnchor recovery. The field names contradicted their semantics
 *   (`insert_after` documented as the payload, read by models as a position) and
 *   V1 declared no field for the payload at all, so the intent was inexpressible.
 *   Measured on gemma4 (3 reps, frozen code): ten pathological events under the
 *   V1 insert surface — eight bounces for a dropped `path`, eight fused-anchor
 *   "recoveries" that reported File edited while duplicating text five times —
 *   and ZERO under V2. Rather than ship the naming fix, the surface is gone:
 *   insertion is now the industry-standard idiom (anchor in `search`, anchor
 *   repeated in `replace`), matching Claude Code, Aider, Cline and apply_patch.
 *   MAJOR because a mechanism was removed and the repair path changed.
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

export const SCAFFOLD_VERSION = '4.0.0';

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

/** Snapshot the active scaffold from a config/arm. `completionGate`,
 *  `injectionGuard`, `adaptiveScaffolding` and `keepBestRatchet` default ON
 *  (mirroring settings.ts); the rest default OFF.
 *
 *  These defaults MUST track settings.ts. `adaptiveScaffolding` read an absent
 *  field as `false` until its real default flipped to `true` — which would have
 *  stamped `adaptiveScaffolding: false` into every run manifest of a run that was
 *  actually using it. A scaffold snapshot that misreports the scaffold defeats the
 *  entire purpose of versioning it. */
export function describeScaffold(cfg: ScaffoldConfigLike): ScaffoldDescriptor {
  return {
    version: SCAFFOLD_VERSION,
    features: {
      completionGate: cfg.completionGateEnabled !== false,
      critic: cfg.criticEnabled === true,
      autoFix: cfg.autoFixOnFailure === true,
      adaptiveScaffolding: cfg.adaptiveScaffoldingEnabled !== false,
      impactGate: cfg.impactGateEnabled === true,
      numericalContractGate: cfg.numericalContractGateEnabled === true,
      analyticBoundsGate: cfg.analyticBoundsGateEnabled === true,
      keepBestRatchet: cfg.keepBestRatchetEnabled !== false,
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
