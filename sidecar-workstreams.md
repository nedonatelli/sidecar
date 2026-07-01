# SideCar — Workstreams (operational tracker)

_The living status board. The three strategy docs are the stable reference —
`sidecar-architecture-and-strategy.md` (why/what), `sidecar-small-model-scaffolding-roadmap.md`
(phases), `sidecar-literature-foundations.md` (grounding). **This** doc is the only
one that churns: it tracks what's built, what's in flight, what's next, what's
parked, and what each claim is measured by. When in doubt about "where are we,"
look here._

**Discipline (from strategy §6): stop widening.** Only items in _Active_ get
built. Everything else is Shipped (done) or Deferred (parked with a reason). A
new idea goes to Deferred with its measuring stick — it does not become Active
until something in Active ships.

---

## Status map

Legend: ✅ shipped · 🔵 in flight · 🟡 partial · ⬜ not started · ⏸ deferred · ❗ needed now

| Workstream                                      | Layer            | Status                                                                  | Measuring stick      |
| ----------------------------------------------- | ---------------- | ----------------------------------------------------------------------- | -------------------- |
| Failure taxonomy + diagnostic metrics (F1/F2)   | Measurement      | ✅                                                                      | `metrics.jsonl`      |
| BFCL — model-level tool-use                     | Measurement      | ✅ ran (local models 83–86%)                                            | BFCL AST subset      |
| SWE-bench ablation harness — system-level       | Measurement      | ✅ built + first no-Docker verdict                                      | resolve@k            |
| pass@k / variance discipline                    | Measurement      | ✅ first result (see Results log)                                       | resolve@k spread     |
| **Pareto-safe scaffolding (keep-best ratchet)** | **Verification** | ❗ **harm found — Active**                                              | **harm rate → 0**    |
| Run provenance (seed / temp / model+quant)      | Measurement      | ❗ needed now                                                           | —                    |
| Constrained-decoding _repair_                   | Reliability      | ✅                                                                      | schema-validity      |
| Schema-constrained tool calls (Phase 1)         | Reliability      | 🟡 core built; **latency tax found** (see Results) → likely repair-only | BFCL on/off          |
| Tier-aware verification (D2/C4/E2)              | Verification     | ✅                                                                      | —                    |
| Mutation testing (verify-the-verifier)          | Verification     | ⬜                                                                      | mutation score       |
| Numerical contract _checking_                   | The vertical     | ✅ (v0.115)                                                             | contract coverage    |
| Property-based + analytic-bound gate            | The vertical     | ⬜                                                                      | catches seeded bug   |
| Shape/dtype/unit constrained _decoding_         | The vertical     | ⬜ frontier                                                             | —                    |
| On-demand capability DB (§2.2–2.5)              | Architecture     | ⏸                                                                       | recall@k, q          |
| Prompt-transform hook (§2.6)                    | Architecture     | ⏸                                                                       | CPS delta            |
| Code graph — query interface / expansion        | Cross-cutting    | 🟡 impact graph shipped                                                 | SWE-bench delta      |
| Injection hardening                             | Cross-cutting    | ⏸                                                                       | AgentDojo            |
| Orchestrator-strength routing                   | Cross-cutting    | ⏸                                                                       | —                    |
| Gate → trajectory flywheel (LoRA, Ph 6)         | Model adapt      | ⏸                                                                       | —                    |
| Literature-doc citation verification            | Docs             | ❗ open                                                                 | IDs resolve on arXiv |

---

## Active (near-term sequence)

Mirrors strategy §6, with **do-no-harm promoted to the front** (a harmful scaffold undermines the
thesis more than a missing lever does). Each produces a citable number.

0. **Pareto-safe scaffolding (keep-best ratchet)** — the completion gate demonstrably **over-engineers**
   (gate-only reliably emits ~32KB test-churn patches where bare stays ~450b; stable behavioral signal).
   Whether that lowers resolve is unprovable at current n (see Results — resolve is noise-dominated), so the
   fix is justified by mechanism + behavior, not a resolve delta. Fix: gate every scaffold-driven change on
   **non-regression** — snapshot → apply → re-verify → keep only if the signal is ≥ before, else revert
   (keep-best moves into the harness, per §2.1); makes over-engineering _safe_. **Signal to optimize: patch
   minimality / over-engineering rate** (measurable at small n), not resolve harm rate (isn't).
1. **Fix the measurement instrument FIRST (it's under-powered).** One task × pass@5 can't detect a real
   effect — a single arm swings 20↔80% between runs. Need: n≥20–30 per arm across several tasks, IID checks
   (back-to-back runs may share GPU/session state), run provenance (seed/temp). Until the instrument is
   trustworthy, **no resolve-level lift/harm claim is defensible** — lean on behavioral signals meanwhile.
2. **Phase 1 — schema-constrained tool calls** — core built for BFCL; run BFCL on/off
   (schema-validity → ~100%, accuracy up-or-flat, watch the alignment tax), then port to
   the agent loop if the delta justifies it.
3. **Verify-the-verifier** — mutation testing on the completion gate. Cheapest credibility.
4. **Numerical vertical hardening** — Hypothesis property-based tests + analytic-bound gate,
   riding on Phase 1. The moat.

---

## Decision log

- **Default model = `gemma4:e4b`** (most-dogfooded; BFCL-competitive; ministral-3 is the lighter alt).
- **Benchmarking = BFCL (model-level) + SWE-bench ablation (system-level).** Scoring delegated to
  the official `swebench` Docker harness; host-local venv scoring works for light pure-Python tasks.
- **Point estimates lie.** Every resolve-level claim needs pass@k + provenance (see Results log —
  flask flipped run-to-run; scaffolding was net-negative on an easy task).
- **Scaffolding value is task-difficulty-dependent** — rescues hard tasks, can over-engineer easy ones.
  A headline lift number requires a difficulty-spanning task set, not one task.
- **Scaffolding must be Pareto-safe (do no harm).** It may never turn a passing run into a failing one.
  Enforced by keep-best/non-regression gating on every intervention + a harm-rate metric that gates
  shipping. A scaffold that relies on the _model_ to execute extra work well is unsafe by design; the
  keep-best judgment belongs in the _harness_.
- **Constrain at the action boundary only** (A2) — grammar the tool call, never the reasoning.

---

## Deferred (parked, with reason)

- **On-demand capability DB (§2.2–2.5)** — biggest speculative build; §6 sequences it last. Build once
  measurement proves it helps (recall@k, q).
- **Prompt-transform hook (§2.6)** — clean design, no demand yet.
- **Injection hardening** — real; do a threat-model pass before it's exploited, not pre-emptively.
- **Orchestrator-strength routing, code-graph query interface, LoRA flywheel** — as metrics demand.

---

## Open questions (gate decisions)

- Verify every post-2501 citation in the literature doc against arXiv (credibility-critical).
- Plan externalization: harness or context? (gates Phase 3.)
- Does the BFCL constrained-decoding delta justify the agent-loop port? (Phase 1 experiment answers.)

---

## Results log

_Append findings as they land — the running record of what we actually measured._

- **BFCL AST subset (100-case sample, Q4_K_M, 32K)** — gemma4:e4b **86%** macro, granite4.1:3b 84%,
  ministral-3 83%. Field-anchored evidence for the small-model thesis; gemma leads → default holds up.
  Caveat: our checker is stricter than upstream on strings; relative ranking is the reliable signal.
- **SWE-bench host-local scoring works without Docker** — flask-5014 gold patch resolves 60/60, base
  fails FAIL*TO_PASS; the scorer discriminates. Only the \_reproducible full-set* scoring needs Docker.
- **flask-5014 pass@5 (gemma4:e4b, Q4_K_M, 30 iters, host-scored):** scaffold-off **4/5**, scaffold-on **1/5**.
  On this _easy_ task the harness is net-negative (over-engineering); the earlier n=1 "+100%" was a lucky
  sample. Confirms the difficulty-dependence decision above and the need for pass@k + a hard-task set.
- **N=20 scoped slice (partial, unscored):** scaffold-on produced a patch on 4/9 tasks vs off's 2/9, with
  2 rescues and 0 reverse — _patch-applicability_ leans toward scaffolding even where _resolve_ is noisy.
- **⚠️ Decomposition pass@5 (flask-5014) — the instrument is under-powered.** All four arms (bare / gate-only /
  critic-only / all) resolved **1/5**; bare was **4/5** in the prior pass@5 and **1/5** here — the same arm's
  resolve rate swings 20↔80% between two pass@5 runs. **At n=5×1-task, no arm comparison is meaningful**; the
  earlier "scaffolding harms (off 4/5, on 1/5)" was partly a lucky draw. Detecting a real resolve effect needs
  n≥20–30 per arm across several tasks (why the field runs the full 500-task set). **Stable signal is behavioral,
  not resolve-level:** gate-only + all reliably emit ~32KB over-engineered patches (test churn); critic-only +
  bare stay ~450b. So the completion gate demonstrably over-engineers — the do-no-harm fix (keep-best ratchet)
  is justified by mechanism + this behavioral signal, NOT by an (unmeasurable-at-this-n) resolve delta. Also:
  run 1 resolved more than runs 2–5 across arms → back-to-back runs may not be IID (GPU/session state).
- **BFCL native vs schema-constrained (gemma4:e4b, Q4_K_M):** native = **87% macro** (100 cases). Constrained
  (Ollama `format`, union tool schema) **timed out at 30 min** having done ~56 cases vs native's fast 100 —
  the Phase-1 cost is **latency, not accuracy** (partial constrained cases passed at a comparable rate).
  Grammar-mask construction over a big `oneOf` schema is expensive for local inference (the §2.5 round-trip
  cost). Implication: constrained decoding is likely best kept as **repair-only** (where we already use it),
  not the default path — pending a clean small-sample accuracy read. Confirms the "constrain at the action
  boundary only" instinct extends to "and only when the latency is affordable."
