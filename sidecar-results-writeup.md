# Proving the math is right, locally: scaffolding a small model toward frontier coding performance

**Status: DRAFT.** Both the BFCL and the SWE-bench ablation numbers are now
final (campaign scored via Modal, scaffold 2.0.0). The headline is honest and
unflattering — a 0% resolve lift at n=50 that the instrument correctly refuses
to over-claim — see §4.2.

---

## TL;DR

- **The bet.** A local-first coding agent whose advantage is not the model — models are commoditized — but the _system_ around it: verification, scoping, context economy, and a correctness discipline for a domain the funded generalists won't chase.
- **What we measure, honestly.** Public benchmarks, reported with uncertainty: **BFCL v4** (tool-use, model level) and a **paired SWE-bench ablation** (the whole agent, scaffold on vs off) scored by the official harness — with confidence intervals and a significance test, so a noise-sized result can't masquerade as a real one.
- **The headline.** Small local models are already competitive on tool use (**gemma4:e4b 86% BFCL macro**). The differentiator is the scaffold-driven **lift** on the real coding loop plus a **numerical-correctness vertical** — shape/dtype/unit contracts, an analytic-bound gate, and property-based test synthesis — that turns "tests pass" into "the physics is right." No agent with 5M installs runs that sentence locally.

---

## 1. Thesis

Capability is largely solved; the moat is the harness. Cognition a small model can't reliably hold — the plan, the tool catalog, prior results, the correctness discipline — moves out of the weights and into the system. The demonstrable claim no competitor can make: **a researcher's coding agent that proves the math is right, running locally.**

## 2. The scaffolding (what's actually built)

| Layer             | Mechanism                                                                                | Purpose                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Structural        | Constrained-decoding **repair** (per-tool schema, action-boundary only)                  | Kill _syntactic_ failures — the class small models add                                |
| Verification      | Completion gate · adversarial critic · regression guards                                 | Kill _semantic_ failures (valid-but-wrong)                                            |
| Verification      | **Keep-best ratchet** (snapshot → apply → re-verify → revert on regression)              | Make scaffolding **Pareto-safe** — it can never turn a passing run into a failing one |
| Verification      | **Mutation testing** (`mutation_test`)                                                   | Verify-the-verifier: prove the tests have teeth                                       |
| The vertical (§5) | Shape/dtype/unit contracts · **analytic-bound gate** · **property-based test synthesis** | Turn "tests pass" into "the physics is right"                                         |
| Cross-cutting     | **Prompt-injection guard** (fence untrusted tool output as data)                         | Reasoning-layer defense; small models are more injection-susceptible                  |
| Cross-cutting     | Code graph (`analyze_impact`, `query_code_graph`)                                        | Understand the _consequences_ of a change before making it                            |

**The two-layer principle.** Grammars guarantee _valid_, never _correct_; tests/gates guarantee _correct_, never _valid_. Each covers the other's blind spot. Constrained decoding is uniquely available to a local-first agent (logit access) and cloud-only agents can't do it.

## 3. Measurement methodology (the honest part)

**Point estimates lie.** Early single-task runs swung 20↔80% between samples; a "+100% lift" at n=1 was a lucky draw. So every claim here carries uncertainty:

- **BFCL v4 (tool use).** AST subset over simple/multiple/parallel/irrelevance categories; **macro** average = unweighted mean of per-category accuracy. Model-level: it measures the model's call-generation, not the harness.
- **SWE-bench ablation (the coding loop).** The flagship. Same model, same task slice, run **scaffold-on vs scaffold-off** — a _paired_ design, so the only pairs carrying signal are the **discordant** ones (rescued vs regressed). Scoring is delegated to the **official `swebench` harness** (apply patch → run FAIL_TO_PASS + PASS_TO_PASS). We report:
  - **Wilson score intervals** on each arm's resolve rate (correct at small n / extreme rates).
  - **McNemar's exact test** on the discordant pairs — the right test for a paired binary ablation.
  - A **hard honesty gate**: when McNemar p ≥ 0.05 the report _refuses_ to claim a resolve lift, names the discordant count, and defers to behavioral signals (patch size, empty-patch rate, latency).
- **Provenance.** Runs are seed-pinned (`SIDECAR_AGENT_SEED`) with a `run.manifest.json` (model, seed, temperature, dataset slice, arms, iterations) so any number is reproducible and attributable.

## 4. Results

### 4.1 Tool use — BFCL v4 (final)

100-case AST subset, Q4_K_M, 32K context, local Ollama:

| Model          | BFCL macro |
| -------------- | ---------- |
| **gemma4:e4b** | **86%**    |
| granite4.1:3b  | 84%        |
| ministral-3    | 83%        |

Native decoding **87% macro** (gemma4:e4b, 100 cases). Constrained decoding over the _union_ tool schema hit a latency tax (grammar-mask construction) with no accuracy gain — which is why SideCar keeps constrained decoding as **repair-only** with the single-tool schema, not the default path. _Caveat: our AST checker is slightly stricter than upstream on strings; the reliable signal is the relative ranking._

### 4.2 The coding loop — SWE-bench ablation ⏳ (campaign running)

**Setup (final):** base model **qwen2.5-coder:7b** (the true ≤8B coder), **SWE-bench Lite**, deterministic stride-50 slice (proportionally representative: django×19, sympy×12, matplotlib×4, scikit-learn×4, pytest×3, sphinx×3, + 6 singletons), 30 agent iterations/task, seed 1234, official harness scoring. Methodology: **50 tasks × 1 sample/arm** (per-task noise averages into a stable _rate_, unlike the 1-task pass@k that drowned earlier).

**Scaffold version: 2.0.0.** The `scaffold-on` arm here = the pre-2.0 mechanism set — **completion gate · adversarial critic · auto-fix · adaptive scaffolding · impact gate · numerical-contract gate**. The 2.0 additions (keep-best ratchet, analytic-bound gate, injection guard, property-test synthesis, strengthened repair) are built but **not yet in this arm's config**, so this campaign isolates the _established_ scaffold. A follow-up "scaffold 2.1" run that opts the new mechanisms into the arm is the next comparison — and because the version + per-arm mechanism snapshot is now in every `run.manifest.json`, the two are provably comparable (or provably not).

**Result (scaffold 2.0.0, swebench harness 4.1.0, Modal-scored):**

| Arm          | Resolved | Rate (95% CI)      | Empty patches | Mean latency |
| ------------ | -------- | ------------------ | ------------- | ------------ |
| scaffold-on  | 2 / 50   | 4.0% [1.1%, 13.5%] | 20            | 50s          |
| scaffold-off | 2 / 50   | 4.0% [1.1%, 13.5%] | 18            | 379s         |

**Lift = +0.0% (95% CI [0%, 0%]), McNemar p = 1.000 — NOT significant. 0 discordant pairs (0 rescued, 0 regressed): both arms resolved the same 2 tasks.**

This is the honesty gate doing its job. At **2/50 resolved**, a 7B is in the _floor regime_ for SWE-bench Lite, and 50 tasks yields **zero discordant pairs** — the instrument has **no power** to detect a scaffold effect here, and it _says so_ rather than printing a misleading number. **We make no resolve-lift claim from this run.** (This is the "point estimates lie" discipline in action — the earlier n=1 "+100%" was exactly the trap this prevents.)

**The usable signal is behavioral, and it's a flag, not a win:** the established `scaffold-on` arm terminated **~7.5× faster (50s vs 379s)** while producing **more** empty patches (20 vs 18). On this slice the scaffold made runs _bail earlier_, not resolve more — which warrants investigation (early-give-up vs. a gate/critic early-exit path) before any scaffold-on claim. It's also _why_ the do-no-harm keep-best ratchet (v2.0, default-off, not in this arm) exists.

**Honest ceiling:** a 7B will not equal a frontier model (~50–70% on Verified); the intended claim was always the **lift + local/zero-cost**, single-to-low-double-digit absolute. This run establishes the **floor + the powered-n requirement**: to detect a real scaffold lift we need enough tasks to accumulate discordant pairs (the field runs 300–500). Next: a larger slice, and a **scaffold-2.1** arm that actually enables the v2.0 mechanisms (the current arm predates them).

## 5. The moat — numerical correctness (§5)

Generic small-model infrastructure is necessary but not differentiating. The edge is **correctness machinery for numerical/scientific code**, now built end-to-end as three pillars:

1. **Shape/dtype/unit contracts** — checked at gate time; a bare `np.ndarray` with no stated shape is flagged.
2. **Analytic-bound gate** — a kernel that declares a value bound (`# bounds: 0 <= result <= 1`, energy ≥ 0, `sum == 1`) but doesn't _enforce_ it is blocked, with the exact assertion to add. A comment is not a guarantee.
3. **Property-based test synthesis** — `synthesize_property_test` emits a runnable Hypothesis test that tries to _violate_ declared invariants (symmetry, idempotence, monotonicity, bounds) across random inputs.

Together these turn "tests pass" into "the physics is right," encoded as gates — the most defensible item in the program, and the one no generalist will build.

## 6. Limitations & what we do NOT claim

- **Not frontier parity.** A local 7B is not GPT-class on SWE-bench; the honest unit is the _lift_ and the _weight-class-relative_ framing.
- **Small-n discipline.** n=50 may not reach significance; the report is built to say so rather than over-claim.
- **Checker strictness.** Our BFCL AST checker is stricter than upstream on some string forms; ranking is the trustworthy signal, not the absolute.
- **Scaffolding is Pareto-safe by construction** (keep-best ratchet), specifically because early dogfooding showed it _could_ over-engineer (a completion gate emitting ~32 KB test-churn where the bare model stayed ~450 b). Do-no-harm is enforced, not assumed.

## 7. Reproducibility

- Deterministic task slice (`fetch_dataset.mjs` — sort by instance_id, fixed stride → identical on any machine).
- Seed-pinned generation + `run.manifest.json` per run — including the **scaffold version** (`SCAFFOLD_VERSION`,
  semver) and a per-arm active-mechanism snapshot, so results are comparable only across matching scaffolds
  (registry: `docs/scaffold-versions.md`). This run: **scaffold 2.0.0**.
- Official `swebench` harness for scoring (Docker or Modal `--modal true`).
- Ablation math + stats: `bench/swe/` (`ablation.ts`, `stats.ts` — Wilson + McNemar), report in `report.ts`.

---

_Companion to `sidecar-architecture-and-strategy.md` (the why/what) and `sidecar-workstreams.md` (the operational tracker). This doc is the outward-facing synthesis — §6 of the strategy: "one decent writeup moves the install number more than fifty more features."_
