# SideCar — Small-Model Agent Architecture & Strategy

_Companion to `sidecar-small-model-scaffolding-roadmap.md` (detailed phase tables live there)._

---

## 1. Thesis & current position

**The bet.** A local-first coding agent whose advantage is not the model — models are commoditized — but the system around it: verification, scoping, context economy, and a correctness discipline tuned for a domain the funded generalists won't chase.

**Where SideCar stands.**

- _Capability_ is largely solved. The verification stack (completion gate, regression guards, adversarial critic), typed sub-agent facets, shadow workspaces, architect/editor split, delegation, prompt pruner, and Model Arena put it ahead of most of the field on the expensive-to-fake axis.
- _Distribution_ is not a capability problem. 115 organic installs with zero marketing is pull, not push — conversion through the weakest possible funnel (marketplace search, 0 reviews suppressing rank). The addressable interest behind that number is much larger than the number. Capability and distribution are orthogonal; the hard one is done.

**The wedge.** A researcher's coding agent that proves the math is right, running locally. No competitor with 5M installs can say that sentence. Everything below either serves that sentence or is infrastructure underneath it.

---

## 2. Core architecture — the unifying model

Several roadmap items are special cases of a few ideas. These are the load-bearing abstractions.

### 2.1 Two failure layers, one principle

- **Syntactic failures** (malformed / invalid tool calls) — the class small models _add_. Killed by constrained decoding (grammars make invalid calls unsamplable). Local-first gives logit access, so this is available to SideCar and not to cloud-only agents.
- **Semantic failures** (valid-but-wrong) — killed by the existing verification stack (tests, types, gates).
- **Principle:** grammars guarantee _valid_, never _correct_. Keep the two layers distinct; each covers the other's blind spot. Cognition that a small model can't reliably hold (the plan, the tool catalog, prior results) moves out of the weights and into the harness.

### 2.2 On-demand capability database

Capabilities (tools, code knowledge, conventions, few-shot trajectories) live in a registry; context is assembled by query. The model only has to learn one stable skill — _how to ask_ — instead of selecting among 80 tools in-context. That single query call is itself grammar-constrainable, so it composes with §2.1.

**The catch — relocated, not removed, difficulty.** This shifts the hard problem from in-context selection to retrieval, and changes a _visible_ failure (wrong tool chosen, auditable) into a _silent_ one (right capability never surfaced; the model can't miss what it never saw). Two constraints keep it from failing:

- **Tiered, not pure on-demand.** A compact always-resident index (categories + one-liners — the _shape_ of what's queryable) plus on-demand detail. Pure on-demand overcorrects from overload into silent starvation. This is the progressive-disclosure / Skills-frontmatter pattern.
- **Structured queries, not free text.** "Write a good semantic query" is itself a skill small models are weak at. Faceted queries (intent / input type / category) are easier and grammar-constrainable.
- Add a **working-set cache** so retrieved capabilities stay resident for the task (else a small model re-queries and thrashes), sharing the same memory substrate as the externalized plan store.

This is not a new system — it is the Project Knowledge Index generalized from "code chunks" to "all capabilities," with tools as one more retrievable document type.

**Method-first bound:** retrieval **recall@k** on tasks with known required-capability sets — measurable without running the agent, and it measures exactly the part that now carries the risk.

### 2.3 Facet composition

SideCar's typed sub-agent facets are an **authorization/scoping** mechanism (allowlist + preferred model + task class). They interlock with §2.2:

- The facet **is a pre-resolved query** — it names the intent and bounds the capability surface deterministically, so on-demand retrieval refines _within_ a sane neighborhood rather than searching everything. This directly answers the silent-starvation risk.
- The facet supplies a **structured prior on every query**: intent/category come from the facet, the model only fills specifics — a much easier ask of a weak model.

**The trap:** don't let the facet allowlist and the registry become two sources of truth about what a capability _is_. Clean split — **facet = scope/policy** (what this agent is allowed and likely to need), **database = the single registry** (what exists + full schema). A facet _resolves to a query_ against the registry; it never holds its own copy of tool definitions, or you're back to 80 allowlists drifting out of sync. **One registry, many facet-shaped views.**

**The payoff — one source of truth.** Facet → task class → (capability scope _and_ smallest sufficient model). Routing, context assembly, and cost control all derive from a single declaration instead of three. That consolidation is worth more than most individual capabilities.

### 2.4 Two-layer retrieval

Facets are task-class granularity — right for scoping, too coarse for within-task retrieval (one coding facet spans many specific capabilities). So: **facets bound the neighborhood, on-demand retrieval picks within it.** Two layers, not one. Collapse them and you lose either the reliable pre-filter or the fine-grained economy.

---

## 3. The scaffolding roadmap (compact)

Full item-level tables and acceptance bounds in the companion file. Sequence respects dependency and ROI.

_(Status column verified against code at v0.114.56, 2026-06-29 — see companion file for per-item evidence.)_

| Phase | Focus                                        | Standout gap                                                                                   | Status                                                                                                                    |
| ----- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0     | Measurement foundation                       | Failure taxonomy + CPS / schema-validity / executable-call metrics; real-task (not smoke) eval | 🟡 — real E2E harness + structured logs exist; taxonomy + 4 diagnostic metrics + scale missing (smaller lift than billed) |
| 1     | Structural guarantees (constrained decoding) | **Grammar-constrained tool calls** — biggest lever, uniquely yours                             | 🟡 — Ollama schema-`format` path plumbed but **dead code** (zero callers); activate, don't build                          |
| 2     | Context economy                              | Per-turn tool subsetting; small-model-specific prompt                                          | ❌ / 🟡 — tools already progressively disclosed (`describe_tool`); B1 less urgent than billed                             |
| 3     | State externalization                        | Plan held in harness, per-turn step re-injection                                               | ❌ — **resolved**: PlanStore is crash-resume snapshot, not a live plan. Genuinely greenfield                              |
| 4     | Verification tuning                          | Make adversarial critic tier-aware (deterministic verifiers for small primary)                 | ✅ / ❌ — gate built; **critic is not tier-aware** (fires identically for Opus and a 3B)                                  |
| 5     | Routing & fallback                           | Failure-triggered escalation; up-front task-type routing                                       | 🟡 — split/role routing built; escalation is error-triggered, not verifier-triggered                                      |
| 6     | Model adaptation (optional)                  | LoRA on your own gate-passed trajectories                                                      | 🟡 — Kickstand LoRA consumption exists; runs logged but not gate-labeled                                                  |

**Priority:** Phase 0 first (method-first; the syntactic-vs-semantic split decides 1-vs-4 ROI) → Phase 1 (A1–A2) → Phase 2 (B1–B2) → Phase 3 (C2). Phases 4–5 are tier-awareness on things already built. Phase 6 only after metrics show a residual the harness can't close.

---

## 4. Cross-cutting concerns

- **Independent benchmarks.** Your own MEEMS-task eval is a self-defined yardstick; pair it with a public one — BFCL v4 / τ-bench / StableToolBench for tool use, SWE-bench / TerminalBench for the coding loop — so the number is comparable to the field and tells you whether a local 3B is at the frontier of its weight class or just passing your smoke tests.
- **Prompt-injection hardening.** The loop ingests untrusted text from many directions (file contents, web results, CI logs, live tickets injected into the prompt). Small models are markedly more injection-susceptible than frontier models, and this operates at the _reasoning_ layer — different from your secrets/vuln scanning. Architectural fix: treat all tool output as data, never instructions; structurally fence retrieved content; never let it silently expand tool permissions. Threat-model pass before it's exploited.
- **Verify the verifier.** The gate is only as strong as its tests, and agents write tests that pass trivially (tautological asserts, hollow mocks). A green gate over wrong code is invisible from the signal you watch. **Mutation testing** — inject faults, confirm the suite catches them — is the independent bound on your bound. Low mutation score = the moat is theater. Purest method-first move available.
- **Code graph.** The Project Knowledge Index is retrieval; it can't tell the agent the _consequences_ of a change (callers, type flow, downstream breakage) — the invisible-20% that separates "edited the file" from "understood the edit." A persistent call/type/dependency graph, built on tree-sitter ASTs you already have, drops into the §2.2 database as another knowledge source.
- **Run provenance.** Agent runs are nondeterministic; for the Research Assistant mode to be reproducible, log per run: model + version, prompt-template version, tool set, temperature, seed. Without it a logged "experiment" can't be rerun. This is what makes the agent a legitimate part of a research methodology rather than a black box.
- **Orchestrator strength.** Fork/merge arbitration and sub-agent aggregation are _reasoning_ tasks — exactly what small models do worst. Run the **strongest** model at the orchestration layer, the cheapest sufficient one at the workers. Inverts the usual cost instinct; that's where the leverage is.
- **Gates as free training labels.** The completion gate + regression guards are already an automatic quality labeler: every gate-passing run is a positive trajectory, every failure a typed negative. Capture runs systematically and your own usage becomes a gate-validated fine-tuning corpus specific to your registry — the flywheel that makes Phase 6 cheap instead of cold-start.

---

## 5. The vertical — the actual moat

Generic small-model infrastructure is necessary but not differentiating. The edge is **correctness machinery for numerical/scientific code**, which is both what serves MEEMS and what no generalist will build:

- Shape / dtype / unit contracts checked at gate time.
- Property-based tests (Hypothesis) on numerical kernels.
- **Validation against analytic bounds** — your own research discipline (method-first against independent bounds) encoded as a verification gate.

This turns "tests pass" into "the physics is right." It is the most defensible item in the entire program and it rides directly on Phase 1 constrained decoding.

---

## 6. Strategy & sequencing

**Stop widening.** The constraint flipped from _what to build_ to _what to finish_. Open threads are not free — each adds maintenance surface, context budget, and drift risk. Generating the next idea is the cheap part; driving one wedge to something demonstrable is the expensive part and where the value is.

**The single move:** take the numerical vertical (§5) riding on constrained decoding (Phase 1), with Phase 0 measurement underneath it, all the way to a result you can show. "Researcher's agent that proves the math is right, running locally" is the demonstrable claim no competitor can make — and it's also the one decent writeup that moves the install number more than fifty more features would. Capability is the asset; the writeup is the megaphone that's simply not yet picked up.

**Recommended order of operations**

1. **Phase 0 measurement** — failure taxonomy + CPS/schema-validity/recall@k. Can't steer otherwise.
2. **Phase 1 grammar-constrained tool calls** — biggest reliability lever, uniquely local.
3. **Numerical correctness gates (§5)** — the differentiator; small surface, high defensibility.
4. **Verify-the-verifier (mutation testing)** — confirms 1–3 are real, not theater.
5. **On-demand capability database + facet resolution (§2.2–2.4)** — the architecture that makes 1–2 scale; build once tooling/measurement exist to prove it helps.
6. Everything else (injection hardening, code graph, provenance, orchestrator routing, LoRA) as metrics demand — not pre-emptively.

---

## 7. Open questions — resolved (code read, v0.114.56, 2026-06-29)

- **Plan externalization (C1–C2): RESOLVED — not externalized.** `PlanStore` writes a full message _snapshot_ to `.sidecar/plans/active.json` each iteration (planStore.ts:4); resume rehydrates the whole history (chatView.ts:271). No structured plan survives compaction. → **Phase 3 is greenfield; priority rises if F1 shows a "lost-plan" bucket.**
- **Lazy schema loading (B3): RESOLVED — split.** Tools defer (extended tools ship as one-line stubs + `describe_tool`, tools.ts:462); skills inject their full body eagerly (skillLoader.ts:15). The 80-tool token tax is already mitigated. → **B1 deprioritized until real overhead is measured.**
- **Phase 0 readiness: RESOLVED — only aggregate pass/fail.** But a real E2E harness (agentHarness.ts runs `runAgentLoop` in sandboxes over 34 cases), cross-model comparison (modelComparison.eval.ts), and structured metrics.jsonl/spend.jsonl already exist. → **Phase 0 = add taxonomy + 4 metrics to existing harness, not build it.**
- **Competitor-matrix claims: CONFIRMED RISK.** The README's "ministral-3 — 94% agent eval pass rate, best agentic score" (README:137) has no published benchmark in-repo; competitor-gap rows are stamped "verified June 2026" and will stale. → **Publish the eval output or soften the wording.**
