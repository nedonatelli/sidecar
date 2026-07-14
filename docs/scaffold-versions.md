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

### 3.1.0 — adaptive scaffolding on by default + learned tiers (2026-07)

MINOR. The default arm composition changed, so runs either side of this boundary
compare only when their per-arm feature snapshots match.

- **`sidecar.adaptiveScaffolding.enabled` defaults to `true`.** Scaffolding is now
  tuned to the model's capability tier out of the box.
- **Tiers are learned, not parsed from the filename.** `parseParamSizeB` read
  `qwen2.5-coder:7b` (5/5 dogfood) and `llama3.2` (2/5) as the same `weak` tier,
  and could not parse `qwen3.5:latest` at all. Precedence is now: user override →
  observed performance in this workspace → tested baseline (`modelBaselines.ts`) →
  name heuristic. Promotion requires the model to have succeeded WITHOUT the
  scaffolding ever firing; demotion needs only failures. (Promoting on success
  alone is circular — a model may be succeeding _because_ of the scaffolding.)
- **`strong` no longer cuts the verification budget.** `maxActionReprompts` and
  `maxGateInjections` were 1; both are back to 2, at parity with `medium`. Strong
  keeps only the latency relaxations (burst cap 16, compression 0.75, deeper
  compaction).

Evidence for the flip:

| tier     | verdict                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `medium` | **Provable no-op.** Every knob is now BUILT from the constant its call site falls back to, so "flag on" and "flag off" are the same run. Pinned by `scaffoldingProfileNeutrality.test.ts`.                                                                                                                                                                                              |
| `weak`   | **Measured flat.** llama3.2 2/5→2/5, ministral-3 5/5→5/5, granite4.1 5/5→5/5 (dogfood, 2 trials, both arms). Not one case moved.                                                                                                                                                                                                                                                        |
| `strong` | **The cut was never justified.** Against claude-sonnet-5: the action reprompt fired in **10/10 runs** — a frontier model narrates instead of acting at least once per task — so a budget of 1 runs permanently at its ceiling. The completion gate injected **0 times**, so the 2→1 cut had never been exercised at all: absence of evidence, not evidence of safety. Budgets restored. |

Note that a `weak` tier's `runLlmCritic: false` is not a guard removal on a default
install — the critic is opt-in (`sidecar.critic.enabled` defaults false) and is
checked before the tier is consulted.

### 3.0.0 — always-on dispatch guards + edit-recovery + text-repair (2026-07)

MAJOR. Shared-path changes, each verified against a live trajectory:

- **Example-replay guard** (always on, no flag): the executor bounces any tool
  call whose arguments verbatim-match the example embedded in that tool's own
  description — restricted to examples with ≥2 arguments, because a legitimate
  single-key call can collide with a single-arg example by coincidence (an
  eval fixture independently chose `src/utils.ts`, the exact path in
  `read_file`'s example). Evidence: llama3.2 replayed the `ask_user` auth-flow
  example (3 args) on a bare "hi" (live chat) and the `edit_file` example
  (3 args) on "thanks, great work!" (guard-probe sweep, 5 models × 4 config
  arms — the only replay signature that fired in 100 probe cases).
- **Escalating dispatch bounces**: schema / malformed-JSON / example-replay /
  unknown-tool bounce messages escalate on consecutive identical repeats
  (2nd: do-not-resubmit; 3rd+: stop-retrying-change-approach) and reset on any
  successful call of the tool.
- **textParsing repair expansion**: the bare-JSON path recognizes the OpenAI
  function-call shape (`{"type":"function","function":{name,parameters}}`) and
  salvages truncated emissions missing the final brace (both observed live from
  llama3.2 — previously dropped silently, making the model look like it
  "chose" not to act). The bare-JSON scanner also counts braces string-aware:
  it previously ran its depth off on a `{` inside a JSON string value, so a
  perfectly-formed rename arrived as `edit_file({})`.
- **Two-tier edit recovery**: when a model's `search` does not match, the intent
  matcher APPLIES its guess only when the winning region beats the runner-up by
  ≥3 distinctive words, and otherwise SUGGESTS the region and writes nothing.
  The bar is measured, not chosen: over 1,700 real edits mined from eleven
  repositories' git history, that margin commits 177 times and is wrong zero
  times, where margin 1 is wrong 6.7% of the time. Suggest-only is the safe
  alternative but costs capability (qwen2.5-coder 5/5 → 3/5 on dogfood); this
  keeps the recovery at zero measured corruption risk.
- **Action reprompt actually fires**: it had been dead on every turn following a
  tool call (tool results are `role:'user'` messages with no text, and that empty
  text was read as the user's intent), so a model that read a file and then
  described the edit in prose terminated as "done" with the file untouched.

Cross-boundary comparability: NOT comparable for weak-model runs —
llama3.2-class models gain tool calls that 2.x silently lost, so resolve/pass
rates measured before and after this version differ for harness reasons, not
model reasons.

### 2.1.0 — keep-best ratchet default-on (2026-07)

MINOR. `sidecar.scaffolding.keepBest` defaults to **true**: every default-config
run now arms the ratchet at the scaffold boundary and reverts unproven
scaffold-tail changes at termination. Evidence (150-run 3-arm SWE campaign,
qwen2.5-coder:7b, Verified N=50): over-engineering rate 36.6→29.6KB mean patch,
6/50 live reverts, no possible resolve harm (0 resolves in all arms — the
resolve non-regression is vacuous at this weight class and must be re-verified
on a resolvable class; recorded in the ROADMAP Prove-or-Prune Ledger). The
asymmetry that justified default-on: the completion gate (whose tail-pressure
causes the damage) has always shipped default-on; its counterweight should too.

### 2.0.1 — keep-best ratchet threshold tightened (2026-07)

PATCH. `DEFAULT_OVER_ENGINEER_BYTES` (in
[`keepBestRatchet.ts`](../src/agent/loop/keepBestRatchet.ts)) tightened from
4096 to 0. A local SWE-bench repro of scaffold-on bail-early found a concrete
case — a 536-byte wrong edit to an unrelated file, driven by a cycle-detection
bail — that slid under the old 4 KB threshold untouched. A byte-size gate alone
can't tell a legitimate small addition from a wrong one, so the default now
reverts **any** scaffold-tail growth that didn't earn a proven test-signal
improvement (a new passing test, or the project suite going green). Raise
`sidecar.scaffolding.keepBestOverEngineerBytes` (or `RatchetOptions.overEngineerBytes`)
to tolerate some unverified growth again. No mechanism added/removed —
comparable with 2.0.0 runs as long as both used the ratchet at all; note the
threshold value itself when comparing patch-bloat-sensitive results.

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
