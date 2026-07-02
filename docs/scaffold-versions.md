---
title: Scaffold Versions
layout: docs
nav_order: 16
---

# Scaffold Versions — the tracked registry

The **scaffold** is SideCar's harness around the model: the verification stack
(completion gate, critic, regression guards), the gates (impact, numerical,
analytic-bound), the guards (keep-best ratchet, injection guard), and the
tool-call repair. A benchmark number (BFCL, SWE-bench resolve/lift) is only
meaningful if you know **which scaffold produced it** — the scaffold evolves,
and a `scaffold-on = 14%` from one version isn't comparable to another's unless
the versions (and the active-mechanism snapshot) match.

This doc is the human-facing registry. The machine-readable source of truth is
[`src/agent/scaffoldVersion.ts`](../src/agent/scaffoldVersion.ts) (`SCAFFOLD_VERSION`

- `describeScaffold`), stamped into every `run.manifest.json` and every ablation
  report.

## Versioning scheme (semver)

The version captures the **implementation** behind the mechanism flags;
`describeScaffold` captures **which flags were on**. **Two runs are comparable
iff both match.**

| Bump              | When                                                                                                                                      | Comparability                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **MAJOR** `X.0.0` | A mechanism is added/removed, or its verification **semantics** change (new gate, changed gate/repair logic, changed do-no-harm behavior) | Cross-MAJOR results are **not** directly comparable  |
| **MINOR** `x.Y.0` | A new mechanism ships behind a flag (default OFF), or a default arm composition changes                                                   | Comparable when the active-mechanism snapshots match |
| **PATCH** `x.y.Z` | Tuning _within_ a mechanism (a threshold, a reprompt string) — no change to which mechanisms run                                          | Comparable; note the patch when reporting            |

**Discipline:** whenever a scaffold mechanism changes, bump `SCAFFOLD_VERSION`,
append a row here and to the changelog in `scaffoldVersion.ts`, and (for a
release) note it in `CHANGELOG.md`. This is part of the release checklist.

## Registry

### 2.0.0 — verification-vertical + do-no-harm (2026-07)

The current baseline. Adds, over 1.x:

- **Keep-best ratchet** (`keepBestRatchet`) — Pareto-safe scaffolding: snapshot →
  apply → re-verify → revert on regression. Scaffolding can't turn a passing run
  into a failing one. _Default OFF._
- **Mutation testing** (`mutation_test` tool) — verify-the-verifier.
- **§5 analytic-bound gate** (`analyticBoundsGate`) — a declared value bound not
  enforced in code is flagged/blocked. _Default OFF (advisory always)._
- **§5 property-based test synthesis** (`synthesize_property_test` tool).
- **Prompt-injection guard** (`injectionGuard`) — fence untrusted tool output as
  data. _Default ON._
- **Strengthened tier-1 tool-call repair** — raw-control-char escaping inside
  string values (multi-line `write_file`/`edit_file` recovery), NaN/Infinity.

**Note on the ablation arm:** at 2.0.0 the SWE-bench `scaffold-on` arm
([`bench/swe/arms.ts`](../bench/swe/arms.ts)) still enables only the pre-2.0
mechanism set — **completion gate · critic · auto-fix · adaptive scaffolding ·
impact gate · numerical-contract gate**. The 2.0 additions are built but not yet
opted into the arm, so a 2.0.0 `scaffold-on` run isolates the _established_
scaffold. The version differs from 1.x because the SHARED path (repair internals,
gate wiring) changed. A future **2.1.0** that adds the new mechanisms to the arm
is the next planned comparison.

### 1.x — pre-2026-07 baseline

Completion gate · adversarial critic · auto-fix · adaptive scaffolding · impact
gate · numerical-contract gate. (Not retroactively versioned; treated as the 1.x
band. Runs from this era lack a `scaffoldVersion` field in their manifest.)

## How it's recorded

- **`run.manifest.json`** (per SWE-bench run) — `scaffoldVersion` + a per-arm
  `scaffold` snapshot (`describeScaffold({...config, ...armOverride})`), so each
  arm's exact active mechanisms are logged.
- **Ablation report** (`ablation.md`) — the reproducibility envelope prints
  `scaffold version: X.Y.Z`.
- **Comparing runs:** match `scaffoldVersion` AND the per-arm feature snapshot.
  If they differ, the delta between two campaigns may be scaffold change, not
  model/task change.
